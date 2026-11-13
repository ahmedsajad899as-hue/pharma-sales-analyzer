// ════════════════════════════════════════════════════════════════════════════
// ViberImportPanel — «📥 استيراد من الفايبر» في صفحة طلبيات المذاخر (ميزة اشتراك
// rep_orders_viber_import).
//
// الفايبر لا يسمح لبوت بقراءة كروب ولا بتحديد عدة رسائل ونسخها معاً، فالإدخال:
//   • كل Ctrl+V لرسالة منسوخة = بطاقة طلبية فوراً (النسخ واحدة واحدة يصير سريعاً)
//   • «مشاركة ← Ordine» على رسالة بالموبايل (sw.js يحفظ النص ← initialText)
//   • أو سكرين شوت (Win+Shift+S ثم Ctrl+V، أو اختيار/سحب/مشاركة الصور) — 3-4 طلبيات بصورة
// الخادم (server/modules/rep-orders/rep-orders.import.js) يُعيد مسوّدات لا يحفظ شيئاً؛
// الحفظ هنا بـ POST /api/rep-orders العادي، والإرسال بمسار «إرسال عبر البوت» نفسه.
//
// والرجوع للفايبر: ViberFeedbackButtons (نسخ الرد + نسخ صورة الفاتورة) في تفاصيل الطلبية.
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, ClipboardPaste, Image as ImageIcon, Trash2, Plus, Check, Copy, Send, ChevronDown } from 'lucide-react';
import { compressImage } from '../../lib/localImage';
import './ViberImportPanel.css';

const API = import.meta.env.VITE_API_URL || '';

interface DraftLine { itemId: number | null; itemName: string; writtenAs: string; quantity: number; bonusQty: number; matched: boolean; suggestions: { id: number; name: string }[] }
interface MentionedWh { id: number | null; name: string; ready?: boolean }
interface Draft {
  key: string; source: 'viber-paste' | 'viber-shot'; sourceText: string; sender: string | null; mentions: string[]; readBy: string;
  pharmacyName: string; areaName: string; warehouseId: number | null; warehouseName: string; backupWarehouseIds: number[];
  mentionedWarehouses: MentionedWh[];
  notes: string; lines: DraftLine[]; repUserId: number | null; repName: string | null; repWhy: 'sender' | 'learned' | 'guess' | null;
  repCandidates: { id: number; name: string }[]; sourceHash: string | null;
  duplicateOf: { id: number; pharmacyName: string; createdAt: string; status: string } | null; dupInBatch: boolean; warnings: string[];
  // الواجهة فقط
  include: boolean; state?: 'saving' | 'done' | 'warn' | 'error'; result?: string; showSource?: boolean;
}
interface Wh { id: number; name: string }
interface Rep { id: number; name: string }

const REP_WHY: Record<string, string> = { sender: 'من اسم المرسل', learned: 'اخترته سابقاً لنفس المرسل', guess: 'تخمين من المواد والمنطقة' };
const dayStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const IS_TOUCH = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/** المذخر الذي تذهب له الطلبية = المختار؛ الاحتياط = باقي المذكورة المطابَقة بترتيب الرسالة. */
function choosePrimary(d: Draft, m: MentionedWh): Partial<Draft> {
  const active = new Set([...(d.warehouseId ? [d.warehouseId] : []), ...d.backupWarehouseIds]);
  const backups = d.mentionedWarehouses
    .filter(x => x.id && x.id !== m.id && active.has(x.id))
    .map(x => x.id as number);
  return { warehouseId: m.id, warehouseName: m.name, backupWarehouseIds: backups };
}

export default function ViberImportPanel({ api, token, warehouses, reps, canSend, initialText, initialImages, onClose, onChanged }: {
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>;
  token: string | null;
  warehouses: Wh[];
  reps: Rep[];
  canSend: boolean;
  /** نصّ وصل بـ«مشاركة ← Ordine» — يُقرأ فور الفتح */
  initialText?: string | null;
  /** سكرين شوت وصل بالمشاركة */
  initialImages?: File[] | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [team, setTeam] = useState<Rep[]>([]);
  const [reading, setReading] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLTextAreaElement>(null);

  const repOptions = (() => {
    const m = new Map<number, string>();
    for (const r of [...reps, ...team]) if (!m.has(r.id)) m.set(r.id, r.name);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  })();

  const addDrafts = useCallback((incoming: Draft[], t: Rep[]) => {
    if (t?.length) setTeam(prev => [...prev, ...t.filter(x => !prev.some(p => p.id === x.id))]);
    setDrafts(prev => {
      const hashes = new Set(prev.map(d => d.sourceHash).filter(Boolean));
      const next = incoming.map(d => {
        const dupInBatch = d.dupInBatch || Boolean(d.sourceHash && hashes.has(d.sourceHash));
        if (d.sourceHash) hashes.add(d.sourceHash);
        return { ...d, mentionedWarehouses: d.mentionedWarehouses ?? [], dupInBatch, include: !dupInBatch && !d.duplicateOf };
      });
      return [...prev, ...next];
    });
  }, []);

  const readText = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setReading(n => n + 1); setErr(null);
    try {
      const r = await api<{ drafts: Draft[]; team: Rep[] }>('/import/text', { method: 'POST', body: JSON.stringify({ blocks: [text] }) });
      if (!r.drafts.length) setErr('لم تُقرأ طلبية من النص');
      addDrafts(r.drafts, r.team);
    } catch (e: any) { setErr(e.message); } finally { setReading(n => n - 1); }
  }, [api, addDrafts]);

  const readImages = useCallback(async (files: File[]) => {
    const imgs = files.filter(f => /^image\//.test(f.type)).slice(0, 8);
    if (!imgs.length) return;
    setReading(n => n + 1); setErr(null);
    try {
      const fd = new FormData();
      // الحروف الصغيرة في السكرين شوت تحتاج دقة أعلى من صور الفواتير المضغوطة
      for (const [i, f] of imgs.entries()) fd.append('images', await compressImage(f, 2200, 0.85), `shot-${i}.jpg`);
      const r = await api<{ drafts: Draft[]; team: Rep[] }>('/import/screenshot', { method: 'POST', body: fd });
      if (!r.drafts.length) setErr('لم تُقرأ طلبيات من الصورة — تأكّد أن الرسائل ظاهرة وواضحة');
      addDrafts(r.drafts, r.team);
    } catch (e: any) { setErr(e.message); } finally { setReading(n => n - 1); }
  }, [api, addDrafts]);

  // ما وصل بالمشاركة يُقرأ مرة واحدة عند الفتح
  const initDone = useRef(false);
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;
    if (initialText) readText(initialText);
    if (initialImages?.length) readImages(initialImages);
  }, [initialText, initialImages, readText, readImages]);

  // Ctrl+V في أي مكان من اللوحة (عدا حقول التعديل) = لصقة جديدة: صورة أو نص
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      const isCapture = t === captureRef.current;
      if (!isCapture && t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!files.length && !text.trim()) return;
      e.preventDefault();
      if (files.length) readImages(files);
      else readText(text);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [readImages, readText]);

  // زر «لصق» للموبايل: يقرأ الحافظة مباشرةً (صورة أو نص) بلا ضغط مطوّل
  const pasteFromClipboard = async () => {
    setErr(null);
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        const files: File[] = [];
        for (const it of items) {
          const type = it.types.find(t => t.startsWith('image/'));
          if (type) files.push(new File([await it.getType(type)], 'clip.png', { type }));
        }
        if (files.length) { readImages(files); return; }
      }
      const text = await navigator.clipboard.readText();
      if (text.trim()) readText(text);
      else setErr('الحافظة فارغة — انسخ رسالة الطلبية من الفايبر أولاً');
    } catch {
      setErr('المتصفح منع قراءة الحافظة — اضغط مطوّلاً على خانة «الصق هنا» واختر لصق');
      captureRef.current?.focus();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const patch = (key: string, p: Partial<Draft>) => setDrafts(ds => ds.map(d => (d.key === key ? { ...d, ...p } : d)));
  const patchLine = (key: string, i: number, p: Partial<DraftLine>) =>
    setDrafts(ds => ds.map(d => (d.key === key ? { ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) } : d)));

  const problemOf = (d: Draft): string | null => {
    if (!d.pharmacyName.trim()) return 'اسم الصيدلية مطلوب';
    if (!d.warehouseId && !d.warehouseName.trim()) return 'اختر المذخر';
    if (!d.lines.some(l => l.itemName.trim() && l.quantity > 0)) return 'لا أصناف بكمية';
    return null;
  };

  const sendBot = async (orderId: number, warehouseId: number) => {
    const res = await fetch(`${API}/api/warehouse-dispatch/rep-order/${orderId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ warehouseId }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.success === false) throw new Error(d.error || d.message || 'تعذّر الإرسال');
    if (d.dispatch?.status && d.dispatch.status !== 'sent') throw new Error(d.dispatch?.error || 'لم يُرسل');
  };

  const create = async (send: boolean) => {
    const todo = drafts.filter(d => d.include && d.state !== 'done' && d.state !== 'warn');
    if (!todo.length) return;
    const bad = todo.map(d => [d, problemOf(d)] as const).filter(([, p]) => p);
    if (bad.length) {
      for (const [d, p] of bad) patch(d.key, { state: 'error', result: p! });
      return;
    }
    setBusy(true);
    for (const d of todo) {
      patch(d.key, { state: 'saving', result: undefined });
      try {
        const r = await api<{ order: { id: number } }>('', {
          method: 'POST',
          body: JSON.stringify({
            orderDate: dayStr(new Date()),
            warehouseId: d.warehouseId, warehouseName: d.warehouseName,
            backupWarehouseIds: d.backupWarehouseIds,
            pharmacyName: d.pharmacyName.trim(), areaName: d.areaName.trim(), notes: d.notes.trim(),
            lines: d.lines.filter(l => l.itemName.trim() && l.quantity > 0)
              .map(l => ({ itemId: l.itemId, itemName: l.itemName.trim(), quantity: l.quantity, bonusQty: l.bonusQty })),
            repUserId: d.repUserId ?? undefined,
            viaBot: false, // الإرسال أدناه صراحةً لكل طلبية (لا يعتمد على وضع الحساب)
            source: d.source, sourceText: d.sourceText, sourceSender: d.sender, sourceHash: d.sourceHash,
          }),
        });
        const id = r.order.id;
        if (send && d.warehouseId) {
          try { await sendBot(id, d.warehouseId); patch(d.key, { state: 'done', result: `#${id} أُرسلت لكروب ${d.warehouseName}` }); }
          catch (e: any) { patch(d.key, { state: 'warn', result: `#${id} أُنشئت — لم تُرسل: ${e.message}` }); }
        } else {
          patch(d.key, { state: send ? 'warn' : 'done', result: send ? `#${id} أُنشئت — المذخر غير مسجّل، أرسلها يدوياً` : `#${id} أُنشئت` });
        }
      } catch (e: any) { patch(d.key, { state: 'error', result: e.message }); }
    }
    setBusy(false);
    onChanged();
  };

  const pending = drafts.filter(d => d.include && d.state !== 'done' && d.state !== 'warn');
  const finished = drafts.filter(d => d.state === 'done' || d.state === 'warn');
  const compactDrop = IS_TOUCH || drafts.length > 0;

  return (
    <div className="ro-modal vi-modal" onClick={() => !busy && onClose()}>
      <div className="ro-dialog vi-dialog" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head vi-head">
          <strong>📥 طلبيات الفايبر</strong>
          {reading > 0 && <span className="vi-reading"><i /> جارٍ القراءة{reading > 1 ? ` (${reading})` : ''}</span>}
          <span className="ro-spacer" />
          <button className="ro-icon-btn" disabled={busy} onClick={onClose}><X size={15} /></button>
        </div>

        <div className="ro-dialog__body vi-body">
          <div className={`vi-drop ${compactDrop ? 'is-compact' : ''} ${dragOver ? 'is-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); readImages([...e.dataTransfer.files]); }}>
            {!compactDrop && (
              <>
                <div className="vi-drop__title">انسخ رسالة من الفايبر ثم <kbd>Ctrl</kbd>+<kbd>V</kbd> هنا — كل لصقة تصير طلبية</div>
                <div className="vi-drop__sub">أو سكرين شوت لعدة طلبيات: <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> ثم <kbd>Ctrl</kbd>+<kbd>V</kbd> · أو اسحب الصور هنا</div>
              </>
            )}
            <div className="vi-drop__row">
              <textarea ref={captureRef} className="form-input vi-capture" rows={1} placeholder="الصق هنا…" value="" onChange={() => {}} />
              <button className="vi-btn" onClick={pasteFromClipboard} title="لصق من الحافظة"><ClipboardPaste size={14} /> لصق</button>
              <button className="vi-btn" onClick={() => fileRef.current?.click()} title="سكرين شوت"><ImageIcon size={14} /> صور</button>
              <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => { readImages([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </div>
          </div>

          {err && <div className="vi-err">⚠️ {err}</div>}

          {drafts.map((d, di) => {
            const locked = d.state === 'done' || d.state === 'warn' || d.state === 'saving';
            const extraWh = warehouses.filter(w => !d.mentionedWarehouses.some(m => m.id === w.id));
            const candIds = new Set(d.repCandidates.map(c => c.id));
            return (
              <div key={d.key} className={`vi-card ${!d.include ? 'is-off' : ''} ${d.state ? `is-${d.state}` : ''}`}>
                {/* الصيدلية والمنطقة */}
                <div className="vi-top">
                  <label className="vi-include" title="تضمين في الإنشاء">
                    <input type="checkbox" checked={d.include} disabled={locked} onChange={e => patch(d.key, { include: e.target.checked })} />
                    <b>{di + 1}</b>
                  </label>
                  <input className="form-input vi-ph" value={d.pharmacyName} disabled={locked} placeholder="الصيدلية *" onChange={e => patch(d.key, { pharmacyName: e.target.value })} />
                  <input className="form-input vi-area" value={d.areaName} disabled={locked} placeholder="المنطقة" onChange={e => patch(d.key, { areaName: e.target.value })} />
                  {!locked && <button className="vi-x" title="حذف" onClick={() => setDrafts(ds => ds.filter(x => x.key !== d.key))}><Trash2 size={13} /></button>}
                </div>

                {(d.duplicateOf || d.dupInBatch || d.readBy === 'ai') && (
                  <div className="vi-badges">
                    {d.duplicateOf && <span className="vi-badge vi-badge--dup">⚠️ مكررة مع #{d.duplicateOf.id}</span>}
                    {d.dupInBatch && !d.duplicateOf && <span className="vi-badge vi-badge--dup">⚠️ مكررة في الدفعة</span>}
                    {d.readBy === 'ai' && <span className="vi-badge">🤖 قُرئت بالذكاء — راجعها</span>}
                  </div>
                )}

                {/* المندوب */}
                <div className="vi-row">
                  <span className="vi-lbl">المندوب</span>
                  <div className="vi-row__val">
                    <select className="form-input" value={d.repUserId ?? ''} disabled={locked}
                      onChange={e => patch(d.key, { repUserId: e.target.value ? Number(e.target.value) : null, repWhy: null })}>
                      <option value="">باسمي</option>
                      {[...repOptions.filter(r => candIds.has(r.id)), ...repOptions.filter(r => !candIds.has(r.id))]
                        .map(r => <option key={r.id} value={r.id}>{candIds.has(r.id) ? '★ ' : ''}{r.name}</option>)}
                    </select>
                    <span className="vi-hint">
                      {d.sender && <>✉️ {d.sender} · </>}
                      {d.repWhy ? REP_WHY[d.repWhy] : d.repCandidates.length > 1 ? 'عدة مرشّحين ★' : !d.repUserId ? 'اختر المندوب' : ''}
                      {d.mentions.length > 0 && <> · @{d.mentions.join(' @')}</>}
                    </span>
                  </div>
                </div>

                {/* المذاخر: كل ما ذُكر في الرسالة — الضغط يختار من تذهب له الطلبية */}
                <div className="vi-row">
                  <span className="vi-lbl">المذخر</span>
                  <div className="vi-row__val vi-whs">
                    {d.mentionedWarehouses.map((m, i) => {
                      const isPrimary = m.id ? m.id === d.warehouseId : !d.warehouseId && m.name === d.warehouseName;
                      const isBackup = !isPrimary && m.id != null && d.backupWarehouseIds.includes(m.id);
                      return (
                        <span key={`${m.id ?? m.name}-${i}`} className={`vi-wh ${isPrimary ? 'is-primary' : isBackup ? 'is-backup' : 'is-off'} ${m.id ? '' : 'is-unknown'}`}>
                          <button disabled={locked} onClick={() => patch(d.key, choosePrimary(d, m))}
                            title={isPrimary ? 'تذهب له الطلبية' : 'اضغط لإرسال الطلبية لهذا المذخر'}>
                            {isPrimary && <Check size={12} />}{m.name}
                            {isBackup && <small>احتياط</small>}
                            {!m.id && <small>غير مسجّل</small>}
                            {m.id && m.ready === false && <small>يدوي</small>}
                          </button>
                          {isBackup && !locked && (
                            <button className="vi-wh__x" title="إزالة من الاحتياط"
                              onClick={() => patch(d.key, { backupWarehouseIds: d.backupWarehouseIds.filter(x => x !== m.id) })}><X size={10} /></button>
                          )}
                        </span>
                      );
                    })}
                    {!locked && extraWh.length > 0 && (
                      <select className="form-input vi-wh-add" value=""
                        onChange={e => {
                          const w = warehouses.find(x => x.id === Number(e.target.value));
                          if (!w) return;
                          const m: MentionedWh = { id: w.id, name: w.name };
                          const next = { ...d, mentionedWarehouses: [...d.mentionedWarehouses, m] };
                          patch(d.key, { mentionedWarehouses: next.mentionedWarehouses, ...choosePrimary(next, m) });
                        }}>
                        <option value="">{d.mentionedWarehouses.length ? '+ مذخر' : 'اختر المذخر'}</option>
                        {extraWh.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                      </select>
                    )}
                  </div>
                </div>

                {/* الأصناف */}
                <div className="vi-lines">
                  {d.lines.map((l, i) => (
                    <div key={i} className={`vi-line ${l.itemId ? 'is-matched' : 'is-free'}`}>
                      {l.itemId
                        ? <span className="vi-line__name" title={l.writtenAs && l.writtenAs !== l.itemName ? `كُتبت: ${l.writtenAs}` : undefined}><Check size={12} /> {l.itemName}</span>
                        : <input className="form-input vi-line__input" value={l.itemName} disabled={locked} placeholder="الصنف" onChange={e => patchLine(d.key, i, { itemName: e.target.value })} />}
                      <input className="form-input vi-num" type="number" min={1} inputMode="numeric" disabled={locked} value={l.quantity || ''} placeholder="ك"
                        onChange={e => patchLine(d.key, i, { quantity: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                      <span className="vi-plus">+</span>
                      <input className="form-input vi-num" type="number" min={0} inputMode="numeric" disabled={locked} value={l.bonusQty || ''} placeholder="ب"
                        onChange={e => patchLine(d.key, i, { bonusQty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                      {!locked
                        ? <button className="vi-x" tabIndex={-1} title="حذف السطر" onClick={() => patch(d.key, { lines: d.lines.filter((_, j) => j !== i) })}><X size={12} /></button>
                        : <span />}
                      {!l.itemId && l.suggestions.length > 0 && !locked && (
                        <select className="form-input vi-sug" value="" onChange={e => { const s = l.suggestions.find(x => x.id === Number(e.target.value)); if (s) patchLine(d.key, i, { itemId: s.id, itemName: s.name, matched: true }); }}>
                          <option value="">ربط «{l.itemName}» بالكتالوج…</option>
                          {l.suggestions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      )}
                    </div>
                  ))}
                </div>

                <div className="vi-foot-row">
                  <input className="form-input vi-notes" value={d.notes} disabled={locked} placeholder="ملاحظات للمذخر" onChange={e => patch(d.key, { notes: e.target.value })} />
                  {!locked && (
                    <button className="vi-btn vi-btn--ghost" title="إضافة صنف"
                      onClick={() => patch(d.key, { lines: [...d.lines, { itemId: null, itemName: '', writtenAs: '', quantity: 0, bonusQty: 0, matched: false, suggestions: [] }] })}>
                      <Plus size={13} /> صنف
                    </button>
                  )}
                  <button className="vi-btn vi-btn--ghost" title="نص الرسالة الأصلي" onClick={() => patch(d.key, { showSource: !d.showSource })}>
                    <ChevronDown size={12} style={{ transform: d.showSource ? 'rotate(180deg)' : undefined }} /> الرسالة
                  </button>
                </div>

                {d.warnings.length > 0 && !locked && <div className="vi-warn">⚠️ {d.warnings.join(' · ')}</div>}
                {d.result && (
                  <div className={`vi-result vi-result--${d.state}`}>
                    {d.state === 'error' ? `⚠️ ${d.result}` : d.state === 'done' ? `✅ ${d.result}` : d.state === 'warn' ? `🟡 ${d.result}` : d.result}
                  </div>
                )}
                {d.showSource && <pre className="vi-src" dir="auto">{d.sourceText}</pre>}
              </div>
            );
          })}
        </div>

        <div className="ro-dialog__foot vi-foot">
          {canSend && (
            <button className="vi-btn vi-btn--primary" disabled={busy || !pending.length} onClick={() => create(true)}>
              <Send size={14} /> {busy ? 'جارٍ…' : `إنشاء وإرسال${pending.length ? ` (${pending.length})` : ''}`}
            </button>
          )}
          <button className={`vi-btn ${canSend ? '' : 'vi-btn--primary'}`} disabled={busy || !pending.length} onClick={() => create(false)}>
            {canSend ? 'إنشاء فقط' : `إنشاء${pending.length ? ` (${pending.length})` : ''}`}
          </button>
          {finished.length > 0 && !busy && (
            <button className="vi-btn vi-btn--ghost" onClick={() => setDrafts(ds => ds.filter(d => d.state !== 'done' && d.state !== 'warn'))}>مسح المنجزة ({finished.length})</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── الرجوع للفايبر: نص الرد + صورة الفاتورة ─────────────────────────────────

interface FbLine { id?: number; itemName: string; quantity: number; bonusQty: number; preparedQty?: number | null; preparedBonus?: number | null }
interface FbSend { warehouseName: string; outcome: 'sent' | 'prepared' | 'partial' | 'rejected'; outcomeAt: string | null; image: string | null; lines: { lineId: number; itemName: string; qty: number; bonus: number }[] }
export interface FbOrder {
  id: number; pharmacyName: string; areaName: string | null; status: 'pending' | 'prepared' | 'cancelled';
  invoiceNumber?: string | null; preparedImage: string | null; preparedAt: string | null; warehouseName: string;
  lines: FbLine[]; sends: FbSend[]; source?: string | null; feedbackCopiedAt?: string | null;
}

const qtyStr = (q: number, b: number) => `${q}${b > 0 ? `+${b}` : ''}`;

/** آخر تغيّر في نتيجة الطلبية (رد مذخر، تجهيز) — للمقارنة مع وقت نسخ الرد. */
const lastOutcomeAt = (o: FbOrder) => {
  const ts = [o.preparedAt, ...o.sends.filter(s => s.outcome !== 'sent').map(s => s.outcomeAt)].filter(Boolean).map(t => new Date(t!).getTime());
  return ts.length ? Math.max(...ts) : 0;
};

/** طلبية من الفايبر لها نتيجة جديدة لم يُنسخ ردّها بعد. */
export const needsViberReply = (o: FbOrder) => {
  if (!o.source?.startsWith('viber')) return false;
  const last = lastOutcomeAt(o);
  if (!last && o.status !== 'cancelled') return false;
  return !o.feedbackCopiedAt || new Date(o.feedbackCopiedAt).getTime() < last;
};

/** نص الرد للصقه في كروب الفايبر (رداً على رسالة المندوب). */
export function viberReplyText(o: FbOrder): string {
  const head = `${o.pharmacyName}${o.areaName ? ` (${o.areaName})` : ''}`;
  if (o.status === 'cancelled') return `🚫 أُلغيت طلبية ${head}`;
  const out: string[] = [];
  const done = o.sends.filter(s => s.outcome === 'prepared' || s.outcome === 'partial');
  const rejected = o.sends.filter(s => s.outcome === 'rejected');
  const missing = o.lines.filter(l => (l.preparedQty ?? 0) < l.quantity);
  const anyPrepared = o.lines.some(l => (l.preparedQty ?? 0) > 0);

  if (o.status === 'prepared') out.push(`✅ تم تجهيز طلبية ${head}`);
  else if (anyPrepared) out.push(`🟡 تجهيز جزئي — ${head}`);
  else if (rejected.length) out.push(`❌ لم تُجهَّز طلبية ${head}`);
  else out.push(`⏳ طلبية ${head} أُرسلت لمذخر ${o.sends[o.sends.length - 1]?.warehouseName || o.warehouseName} — بانتظار التجهيز`);

  for (const s of done) {
    const items = s.lines.filter(l => l.qty > 0).map(l => `${l.itemName} ${qtyStr(l.qty, l.bonus)}`);
    out.push(`من ${s.warehouseName}:${items.length ? `\n${items.join('\n')}` : ' كاملة'}`);
  }
  if (!done.length && anyPrepared) {
    out.push(o.lines.filter(l => (l.preparedQty ?? 0) > 0).map(l => `${l.itemName} ${qtyStr(l.preparedQty ?? 0, l.preparedBonus ?? 0)}`).join('\n'));
  }
  if (anyPrepared && missing.length && o.status !== 'prepared') {
    out.push(`الناقص:\n${missing.map(l => `${l.itemName} ${l.quantity - (l.preparedQty ?? 0)}`).join('\n')}`);
  }
  if (rejected.length && o.status !== 'prepared') out.push(`رفض: ${rejected.map(s => s.warehouseName).join('، ')}`);
  if (o.invoiceNumber) out.push(`فاتورة رقم ${o.invoiceNumber}`);
  return out.filter(Boolean).join('\n');
}

/** صورة الفاتورة الأحدث: صورة التجهيز، وإلا آخر صورة رد من مذخر. */
const invoiceImageOf = (o: FbOrder) => o.preparedImage || [...o.sends].reverse().find(s => s.image && !/\.pdf$/i.test(s.image))?.image || null;

async function toPngBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error('تعذّر تحميل الصورة');
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return new Promise((ok, bad) => c.toBlob(b => (b ? ok(b) : bad(new Error('تعذّر تحويل الصورة'))), 'image/png'));
}

export function ViberFeedbackButtons({ order, token, onCopied }: { order: FbOrder; token: string | null; onCopied?: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const img = invoiceImageOf(order);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);

  const mark = () => fetch(`${API}/api/rep-orders/${order.id}/feedback-copied`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }).then(() => onCopied?.()).catch(() => {});

  const copyReply = async () => {
    const text = viberReplyText(order);
    try { await navigator.clipboard.writeText(text); setMsg('نُسخ الرد — الصقه رداً على رسالة المندوب في الفايبر'); mark(); }
    catch { setMsg('تعذّر النسخ'); }
  };
  const copyImage = async () => {
    if (!img) return;
    try {
      // ClipboardItem يقبل Promise — يبقى النسخ داخل ضغطة المستخدم (Safari)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPngBlob(`${API}${img}`) })]);
      setMsg('نُسخت صورة الفاتورة — الصقها في الفايبر'); mark();
    } catch { setMsg('تعذّر نسخ الصورة في هذا المتصفح'); }
  };

  // الموبايل: «مشاركة ← فايبر» ترسل النص وصورة الفاتورة معاً بدل النسخ واللصق
  const shareReply = async () => {
    const text = viberReplyText(order);
    try {
      let files: File[] | undefined;
      if (img) {
        const blob = await fetch(`${API}${img}`, { cache: 'force-cache' }).then(r => (r.ok ? r.blob() : null)).catch(() => null);
        if (blob) files = [new File([blob], `invoice-${order.id}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, { type: blob.type || 'image/jpeg' })];
      }
      const data: ShareData = files && navigator.canShare?.({ files }) ? { text, files } : { text };
      await navigator.share(data);
      mark();
    } catch (e: any) {
      if (e?.name !== 'AbortError') copyReply();
    }
  };

  if (IS_TOUCH && typeof navigator.share === 'function') {
    return (
      <span className="vi-fb">
        <button className="btn btn--secondary btn--sm" onClick={shareReply} title="مشاركة نتيجة التجهيز وصورة الفاتورة للفايبر"><Send size={14} /> مشاركة الرد للفايبر</button>
        <button className="btn btn--secondary btn--sm" onClick={copyReply} title="نسخ نص الرد فقط"><Copy size={14} /></button>
        {order.feedbackCopiedAt && !needsViberReply(order) && <span className="vi-fb__done">✓ أُرسل الرد</span>}
        {msg && <span className="vi-fb__msg">{msg}</span>}
      </span>
    );
  }

  return (
    <span className="vi-fb">
      <button className="btn btn--secondary btn--sm" onClick={copyReply} title="نص جاهز بنتيجة التجهيز للصقه في كروب الفايبر"><Copy size={14} /> نسخ الرد للفايبر</button>
      {img && <button className="btn btn--secondary btn--sm" onClick={copyImage} title="نسخ صورة فاتورة المذخر للصقها في الفايبر"><ImageIcon size={14} /> نسخ الفاتورة</button>}
      {order.feedbackCopiedAt && !needsViberReply(order) && <span className="vi-fb__done">✓ نُسخ الرد</span>}
      {msg && <span className="vi-fb__msg">{msg}</span>}
    </span>
  );
}
