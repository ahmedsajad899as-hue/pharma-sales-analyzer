// ════════════════════════════════════════════════════════════════════════════
// salesFolder.ts — «مجلد المبيعات» (المرحلة 3 من الرفع اليومي).
//
// المستخدم يربط مجلداً على حاسبته (File System Access API — Chrome/Edge على الحاسبة فقط)
// يحفظ فيه إكسلات المبيعات اليومية. ما دام التطبيق مفتوحاً، يُفحص المجلد كل 3 دقائق وعند
// العودة للتبويب: كل ملف جديد أو تغيّر (الحجم أو وقت التعديل) يُرسل إلى
// POST /api/upload-sales/auto، فيُرفع تلقائياً إن كانت معاينته سليمة، وإلا يُحجز للمراجعة
// في نافذة «الرفع الذكي». لا تثبيت ولا مفتاح دخول جديد: الطلب بجلسة المستخدم نفسها.
//
// المقبض (FileSystemDirectoryHandle) يُحفظ في IndexedDB لكل مستخدم. بعد إعادة فتح المتصفح
// قد يطلب المتصفح إذن القراءة من جديد بضغطة (requestAccess) — لا يُطلب إلا بفعل المستخدم.
// تبويبان مفتوحان لا يفحصان معاً (navigator.locks).
// ════════════════════════════════════════════════════════════════════════════

export type FolderAction = 'uploaded' | 'review' | 'nothing' | 'error';

export interface FolderLogEntry {
  at: number;
  file: string;
  action: FolderAction;
  text: string;
}

export interface FolderUploadResult {
  fileId: number;
  sourceSystem: string | null;
  unknownItems: string[];
}

export interface FolderStatus {
  supported: boolean;
  linked: boolean;
  folderName: string | null;
  permission: 'granted' | 'prompt' | 'denied' | null;
  auto: boolean;
  scanning: boolean;
  lastScan: number | null;
  log: FolderLogEntry[];
  /** ملفات تنتظر المراجعة في «الرفع الذكي» مع سبب كل منها */
  review: Array<{ file: File; reasons: string[] }>;
  error: string | null;
}

const SCAN_EVERY_MS = 3 * 60_000;
/** ملف عُدِّل للتو قد يكون الإكسل ما زال يكتبه — يُترك للفحص التالي. */
const SETTLE_MS = 60_000;
/** عند الربط: ملفات أقدم من هذا تُعدّ مرفوعة سابقاً (لا يُعاد فحص أرشيف المجلد كله). */
const FRESH_ON_LINK_MS = 2 * 86_400_000;
const MAX_FILES_PER_SCAN = 10;
const MAX_ERRORS_PER_FILE = 3;
const EXCEL_RE = /\.(xlsx|xls|csv)$/i;

const anyWindow = window as any;
const supported = typeof anyWindow.showDirectoryPicker === 'function';

// ── التخزين ────────────────────────────────────────────────────────────────

const DB_NAME = 'ordine-sales-folder';
function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('handles');
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction('handles', mode);
          const req = run(tx.objectStore('handles'));
          req.onsuccess = () => resolve((req.result as T) ?? null);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
    } catch { resolve(null); }
  });
}

interface Saved {
  auto: boolean;
  /** اسم الملف ← «الحجم|وقت التعديل» آخر ما عولج */
  seen: Record<string, string>;
  errors: Record<string, number>;
  log: FolderLogEntry[];
  lastScan: number | null;
}
const emptySaved = (): Saved => ({ auto: true, seen: {}, errors: {}, log: [], lastScan: null });

// ── الحالة ─────────────────────────────────────────────────────────────────

let userId: number | null = null;
let token: string | null = null;
let handle: any = null;
let saved: Saved = emptySaved();
let timer: ReturnType<typeof setInterval> | null = null;
let onUploaded: ((r: FolderUploadResult) => void) | null = null;
let status: FolderStatus = {
  supported, linked: false, folderName: null, permission: null, auto: true,
  scanning: false, lastScan: null, log: [], review: [], error: null,
};
const listeners = new Set<(s: FolderStatus) => void>();

const savedKey = () => `salesFolder_${userId}`;
function loadSaved(): Saved {
  try { return { ...emptySaved(), ...JSON.parse(localStorage.getItem(savedKey()) || '{}') }; } catch { return emptySaved(); }
}
function persist() {
  try { localStorage.setItem(savedKey(), JSON.stringify(saved)); } catch { /* التخزين ممتلئ أو محجوب */ }
}
function emit(p: Partial<FolderStatus> = {}) {
  status = { ...status, ...p, auto: saved.auto, log: saved.log, lastScan: saved.lastScan };
  listeners.forEach(l => l(status));
}
function addLog(e: Omit<FolderLogEntry, 'at'>) {
  // قراءة seen/errors من التخزين قبل الكتابة: تبويب آخر ربما عالج ملفات في الأثناء.
  saved = { ...loadSaved(), log: [{ ...e, at: Date.now() }, ...loadSaved().log].slice(0, 15) };
  persist();
}

export function subscribe(l: (s: FolderStatus) => void): () => void {
  listeners.add(l);
  l(status);
  return () => { listeners.delete(l); };
}
export const getStatus = () => status;

async function permissionOf(h: any, request = false): Promise<FolderStatus['permission']> {
  try {
    const opts = { mode: 'read' };
    let p = await h.queryPermission(opts);
    if (p !== 'granted' && request) p = await h.requestPermission(opts);
    return p;
  } catch { return 'denied'; }
}

// ── دورة الحياة ────────────────────────────────────────────────────────────

/** يُستدعى من App بعد الدخول. يعيد تحميل المجلد المربوط ويبدأ الفحص الدوري. */
export async function start(opts: { userId: number; token: string; onUploaded: (r: FolderUploadResult) => void }) {
  if (userId === opts.userId && token === opts.token && timer) return;
  stop();
  userId = opts.userId;
  token = opts.token;
  onUploaded = opts.onUploaded;
  saved = loadSaved();
  if (!supported) { emit({ supported: false }); return; }
  handle = await idb<any>('readonly', s => s.get(String(userId)));
  if (!handle) { emit({ linked: false, folderName: null, permission: null }); return; }
  const permission = await permissionOf(handle);
  emit({ linked: true, folderName: handle.name, permission, error: null });
  timer = setInterval(() => { void scan(); }, SCAN_EVERY_MS);
  window.addEventListener('focus', onFocus);
  if (permission === 'granted') void scan();
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener('focus', onFocus);
  handle = null;
  userId = null;
  token = null;
  status = { ...status, linked: false, folderName: null, permission: null, review: [], scanning: false };
}

let focusTimer: ReturnType<typeof setTimeout> | null = null;
function onFocus() {
  // عائد من الإكسل بعد حفظ ملف: افحص بعد أن يستقر الملف.
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => { void scan(); }, 5_000);
}

/** يربط مجلداً (بفعل المستخدم). الملفات الأقدم من يومين تُعدّ مرفوعة سابقاً. */
export async function link(): Promise<boolean> {
  if (!supported || userId == null) return false;
  let h: any;
  try { h = await anyWindow.showDirectoryPicker({ id: 'ordine-sales', mode: 'read' }); } catch { return false; }
  await idb('readwrite', s => s.put(h, String(userId)));
  handle = h;
  saved = { ...emptySaved(), auto: saved.auto };
  const now = Date.now();
  for await (const entry of h.values()) {
    if (entry.kind !== 'file' || !EXCEL_RE.test(entry.name) || entry.name.startsWith('~$')) continue;
    const f: File = await entry.getFile();
    if (now - f.lastModified > FRESH_ON_LINK_MS) saved.seen[entry.name] = `${f.size}|${f.lastModified}`;
  }
  persist();
  emit({ linked: true, folderName: h.name, permission: 'granted', error: null, review: [] });
  if (!timer) {
    timer = setInterval(() => { void scan(); }, SCAN_EVERY_MS);
    window.addEventListener('focus', onFocus);
  }
  void scan();
  return true;
}

export async function unlink() {
  if (userId == null) return;
  await idb('readwrite', s => s.delete(String(userId)));
  try { localStorage.removeItem(savedKey()); } catch { /* */ }
  if (timer) clearInterval(timer);
  timer = null;
  handle = null;
  saved = emptySaved();
  emit({ linked: false, folderName: null, permission: null, review: [], error: null });
}

/** بعد إعادة فتح المتصفح: إذن القراءة يحتاج ضغطة من المستخدم. */
export async function requestAccess() {
  if (!handle) return;
  const permission = await permissionOf(handle, true);
  emit({ permission });
  if (permission === 'granted') void scan();
}

export function setAuto(auto: boolean) {
  saved = { ...loadSaved(), auto };
  persist();
  emit();
}

/** يعيد فحص كل الملفات (حتى ما عولج سابقاً) — الرفع يُسقط المكرر على كل حال. */
export function rescanAll() {
  saved = { ...loadSaved(), seen: {}, errors: {} };
  persist();
  void scan();
}

/** يسلّم ملفات المراجعة لنافذة «الرفع الذكي» ويعدّها معالَجة. */
export function takeReview(): File[] {
  const files = status.review.map(r => r.file);
  emit({ review: [] });
  return files;
}
export function dismissReview() { emit({ review: [] }); }

// ── الفحص ──────────────────────────────────────────────────────────────────

export async function scan(): Promise<void> {
  if (!handle || status.scanning || token == null) return;
  if (status.permission !== 'granted') {
    const p = await permissionOf(handle);
    if (p !== 'granted') { emit({ permission: p }); return; }
    emit({ permission: p });
  }
  const locks = (navigator as any).locks;
  if (locks?.request) {
    await locks.request(`ordine-sales-folder-${userId}`, { ifAvailable: true }, async (lock: unknown) => { if (lock) await scanLocked(); });
  } else {
    await scanLocked();
  }
}

async function scanLocked() {
  emit({ scanning: true, error: null });
  try {
    saved = loadSaved();
    const now = Date.now();
    const due: Array<{ name: string; sig: string; file: File }> = [];
    for await (const entry of handle.values()) {
      if (entry.kind !== 'file' || !EXCEL_RE.test(entry.name) || entry.name.startsWith('~$')) continue;
      let f: File;
      try { f = await entry.getFile(); } catch { continue; } // مقفل بالإكسل لحظتها
      const sig = `${f.size}|${f.lastModified}`;
      if (saved.seen[entry.name] === sig) continue;
      if (now - f.lastModified < SETTLE_MS) continue;
      if (status.review.some(r => r.file.name === entry.name && r.file.lastModified === f.lastModified)) continue;
      due.push({ name: entry.name, sig, file: f });
    }
    due.sort((a, b) => a.file.lastModified - b.file.lastModified);
    for (const d of due.slice(0, MAX_FILES_PER_SCAN)) await handleFile(d);
    saved = { ...loadSaved(), lastScan: Date.now() };
    persist();
    emit({ scanning: false });
  } catch (e: any) {
    emit({ scanning: false, error: e?.message || 'تعذّر فحص المجلد' });
  }
}

const markSeen = (name: string, sig: string) => {
  const s = loadSaved();
  delete s.errors[name];
  saved = { ...s, seen: { ...s.seen, [name]: sig } };
  persist();
};

async function handleFile({ name, sig, file }: { name: string; sig: string; file: File }) {
  // اقرأ الملف إلى الذاكرة أولاً: الإكسل قد يكتب فوقه أثناء الإرسال.
  let blob: Blob;
  try { blob = new Blob([await file.arrayBuffer()], { type: file.type }); } catch { return; }

  if (!saved.auto) {
    emit({ review: [...status.review, { file, reasons: ['الرفع التلقائي مُطفأ'] }] });
    markSeen(name, sig);
    addLog({ file: name, action: 'review', text: 'بانتظار المراجعة' });
    return;
  }
  try {
    const fd = new FormData();
    fd.append('file', blob, name);
    const res = await fetch('/api/upload-sales/auto', { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.success) throw new Error(String(j.message || j.error || `HTTP ${res.status}`).split('\n')[0]);
    const d = j.data;
    markSeen(name, sig);
    if (d.action === 'uploaded') {
      const m = d.result?.merge ?? {};
      const hidden = m.superseded && !m.superseded.skipped ? m.superseded.count : 0;
      addLog({ file: name, action: 'uploaded', text: `أُضيف ${m.added ?? 0}${hidden ? ` · أُخفي ${hidden} قديم` : ''} ← ${m.fileName ?? ''}` });
      const uf = d.result?.uploadedFile;
      if (uf?.id) onUploaded?.({ fileId: uf.id, sourceSystem: uf.sourceSystem ?? null, unknownItems: d.result?.unknownItems ?? [] });
    } else if (d.action === 'review') {
      emit({ review: [...status.review, { file: new File([blob], name, { lastModified: file.lastModified }), reasons: d.reasons ?? [] }] });
      addLog({ file: name, action: 'review', text: `يحتاج مراجعة: ${(d.reasons ?? []).join('، ')}` });
    } else {
      addLog({ file: name, action: 'nothing', text: 'لا جديد' });
    }
  } catch (e: any) {
    const s = loadSaved();
    const n = (s.errors[name] ?? 0) + 1;
    saved = { ...s, errors: { ...s.errors, [name]: n } };
    persist();
    // بعد 3 محاولات يُترك حتى يتغيّر الملف — لا يُعاد كل 3 دقائق للأبد.
    if (n >= MAX_ERRORS_PER_FILE) markSeen(name, sig);
    addLog({ file: name, action: 'error', text: e?.message || 'فشل الرفع' });
  }
}
