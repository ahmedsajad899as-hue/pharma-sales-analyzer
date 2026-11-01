// ════════════════════════════════════════════════════════════════════════════
// autoUpdate.ts — النسخة الجديدة تصل بعد كل نشر بلا «ري فرش» يدوي.
//
// كل نشر للواجهة يغيّر بصمة حزمة الدخول (/assets/index-<hash>.js) في index.html:
// حزمة الدخول تحمل أسماء حزم الصفحات، فأي تغيير في أي صفحة يتسلسل إليها. نقرأ
// index.html دورياً ونقارن بصمته بالتي تعمل الآن — نشرٌ للخادم وحده لا يغيّرها
// فلا يُعاد التحميل بلا داعٍ.
//
// إعادة التحميل تنتظر لحظة آمنة كي لا تضيع شغلة غير محفوظة:
//   • الانتقال لصفحة أخرى (reloadIfUpdatePending في navigateTo) — فوراً؛
//   • خمول IDLE_MS بلا نافذة مفتوحة ولا خانة قيد الكتابة ولا حفظ/رفع جارٍ.
// وشريط صغير أعلى الشاشة يعرض «تحديث الآن» لمن يريده فوراً.
// lastPage محفوظ في localStorage فيعود المستخدم لنفس الصفحة بعد التحميل.
// ════════════════════════════════════════════════════════════════════════════

const CHECK_EVERY_MS = 90_000;
const IDLE_MS        = 10 * 60_000;

const ENTRY_RE = /<script[^>]*\ssrc="(\/assets\/index-[^"]+\.js)"/;
// تعديل App.css وحده لا يغيّر حزمة الدخول — ملف التنسيق الرئيسي جزء من البصمة.
const CSS_RE = /<link[^>]*\shref="(\/assets\/index-[^"]+\.css)"/g;
const entry = document
  .querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
  ?.getAttribute('src') ?? null;
const running = entry && [entry, ...Array.from(
  document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href*="/assets/index-"]'),
  l => l.getAttribute('href') ?? '',
)].join('|');

let pending = false;
let lastInput = Date.now();
let lastCheck = 0;
let writesInFlight = 0;

/** طلب كتابة (حفظ/رفع) جارٍ — إعادة التحميل تقطعه. */
function trackWrites() {
  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' || method === 'HEAD') return origFetch(input, init);
    writesInFlight++;
    return origFetch(input, init).finally(() => { writesInFlight--; });
  };
  // axios (رفع الملفات في بعض الصفحات) يمرّ عبر XMLHttpRequest لا fetch.
  const methods = new WeakMap<XMLHttpRequest, string>();
  const proto = XMLHttpRequest.prototype as any;
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = function (this: XMLHttpRequest, method: string, ...rest: unknown[]) {
    methods.set(this, String(method).toUpperCase());
    return origOpen.call(this, method, ...rest);
  };
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const m = methods.get(this);
    if (m && m !== 'GET' && m !== 'HEAD') {
      writesInFlight++;
      this.addEventListener('loadend', () => { writesInFlight--; }, { once: true });
    }
    return origSend.call(this, body);
  };
}

/** نافذة منبثقة مفتوحة = طبقة fixed تغطي معظم الشاشة في منتصفها (inline أو .modal-overlay). */
function hasOpenOverlay() {
  const vw = window.innerWidth, vh = window.innerHeight;
  return document.elementsFromPoint(vw / 2, vh / 2).some(el => {
    if (getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width >= vw * 0.6 && r.height >= vh * 0.6;
  });
}

function isEditing() {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}

const safeToReload = () => writesInFlight === 0 && !hasOpenOverlay() && !isEditing();

function reload() {
  try { sessionStorage.removeItem('chunkErrReload'); } catch {}
  window.location.reload();
}

/** مفتاح الصفحة التي طُلبت لحظة التحميل — App يفتحها أولاً (قبل قواعد الصفحة الافتتاحية للدور). */
export const UPDATE_TARGET_KEY = 'au-page';

/** يُستدعى عند الانتقال لصفحة أخرى: إن وصلت نسخة جديدة تُحمَّل الآن على الصفحة المطلوبة. */
export function reloadIfUpdatePending(page: string): boolean {
  if (!pending || writesInFlight > 0) return false;
  try { sessionStorage.setItem(UPDATE_TARGET_KEY, page); } catch {}
  reload();
  return true;
}

function showToast() {
  if (document.getElementById('app-update-toast')) return;
  const bar = document.createElement('div');
  bar.id = 'app-update-toast';
  bar.className = 'notranslate';
  bar.setAttribute('translate', 'no');
  bar.dir = 'rtl';
  bar.title = 'تُطبَّق تلقائياً عند الانتقال لصفحة أخرى، أو اضغط «تحديث الآن»';
  bar.style.cssText = 'position:fixed;top:74px;left:50%;transform:translateX(-50%);z-index:100000;'
    + 'display:flex;align-items:center;gap:10px;padding:6px 6px 6px 14px;border-radius:999px;'
    + 'background:#fff;color:#0f172a;border:1px solid #bbf7d0;font-size:12.5px;font-weight:600;font-family:inherit;'
    + 'box-shadow:0 6px 20px rgba(15,23,42,.18);white-space:nowrap;max-width:calc(100vw - 20px)';
  const text = document.createElement('span');
  text.textContent = '🔄 نسخة جديدة — تُطبَّق تلقائياً';
  const btn = document.createElement('button');
  btn.textContent = 'تحديث الآن';
  btn.style.cssText = 'border:none;border-radius:999px;padding:5px 12px;background:#22c55e;color:#fff;'
    + 'font-weight:700;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap';
  btn.onclick = reload;
  bar.append(text, btn);
  document.body.appendChild(bar);
}

async function check() {
  if (pending || !navigator.onLine) return;
  lastCheck = Date.now();
  try {
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const nextEntry = html.match(ENTRY_RE)?.[1];
    if (!nextEntry) return;
    const next = [nextEntry, ...Array.from(html.matchAll(CSS_RE), m => m[1])].join('|');
    if (next === running) return;
    // النشر يحذف الحزم القديمة ثم يفكّ الجديدة: لا نعتمد النسخة حتى تكون حزمتها
    // موجودة فعلاً (وإلا قد نُحمّل في منتصف النشر صفحةً بيضاء — المسار المفقود
    // يعود بـindex.html و200، فالحَكَم نوع المحتوى لا الحالة).
    const head = await fetch(nextEntry, { method: 'HEAD', cache: 'no-store' });
    if (!head.ok || !(head.headers.get('content-type') ?? '').includes('javascript')) return;
    pending = true;
    showToast();
  } catch { /* بلا شبكة — الدورة التالية تعيد المحاولة */ }
}

export function startAutoUpdate() {
  // وضع التطوير (vite dev) لا يحمل حزمة دخول مبنية — لا شيء نقارنه.
  if (!running) return;
  trackWrites();
  const touch = () => { lastInput = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, touch, { capture: true, passive: true });
  }
  setInterval(() => {
    if (!document.hidden) check();
    if (pending && Date.now() - lastInput >= IDLE_MS && safeToReload()) reload();
  }, CHECK_EVERY_MS);
  // الرجوع للتطبيق (من تطبيق آخر/تبويب آخر) فحصٌ فوري بدل انتظار الدورة.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastCheck > 20_000) check();
  });
}
