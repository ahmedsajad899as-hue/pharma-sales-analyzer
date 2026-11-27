// ════════════════════════════════════════════════════════════════════════════
// heavyGetCache — مخبأ ردود تقارير GET الثقيلة («مندوبين المحافظات» و«مندوبين بغداد»).
//
// province-map كان يأخذ 20–75 ثانية (تقرير كامل لكل مندوب من ~95)، والفرق والملخص
// 10–20 ثانية، على سيرفر بمعالج واحد. الصفحة نفسها تطلب الشيء مرتين (الجدول ثم نافذة
// الفرق، والتحميل المسبق للأشهر ثم فتح الشهر) فيُحسب التقرير الثقيل مرتين.
//
//   • المفتاح = التوكن + الرابط الكامل: لا يرى أحد رد غيره ولا رد دور آخر.
//   • طلبان متطابقان في الوقت نفسه → حساب واحد، والثاني ينتظر نتيجة الأول.
//   • الطلب يكمل ويُخبَّأ حتى لو أُغلق الاتصال (المتصفح ألغاه) — فلا يضيع وقت المعالج.
//   • أي كتابة ناجحة (POST/PUT/PATCH/DELETE) على /api تُبطل المخبأ كله: الرقم بعد تأكيد
//     مبيع أو رفع ملف يُحسب من جديد. كتابات البوت الداخلية يغطيها عمر المخبأ (FRESH_MS).
// ════════════════════════════════════════════════════════════════════════════

const FRESH_MS = 4 * 60 * 1000;
const MAX_ENTRIES = 80;
const MAX_BODY = 3 * 1024 * 1024; // رد أكبر لا يُخبّأ — ذاكرة السيرفر محدودة

const HEAVY_PATHS = [
  /^\/api\/scientific-reps\/province-map$/,
  /^\/api\/scientific-reps\/group-report$/,
  /^\/api\/scientific-reps\/warehouse-summary$/,
  /^\/api\/scientific-reps\/rep-names\/check$/,
  /^\/api\/scientific-reps\/\d+\/report$/,
  /^\/api\/province-teams\/directory$/,
  /^\/api\/province-teams\/rep-lines$/,
  /^\/api\/province-teams\/all-lines$/,
  /^\/api\/rep-sales\/province-summary$/,
  /^\/api\/rep-sales\/daily-liquidation$/,
  /^\/api\/targets\/actuals$/,
  // condition-view: له مخبأ خاص بالمستخدم في index.js (يعرض القديم فوراً ويحدّث بالخلفية).
];
// كتابات لا تمسّ الأرقام
const NON_DATA_WRITES = /^\/api\/(engagement|auth)\b/;

let dataVersion = 0;
/** رقم نسخة البيانات — يزيد مع كل كتابة HTTP ناجحة. لمذكّرات داخلية تُبطَل معه. */
export const getDataVersion = () => dataVersion;
const cache = new Map();    // key -> { at, ver, status, body }
const inflight = new Map(); // key -> Promise<{ status, body } | null>

/** يُبطل المخبأ بعد كل كتابة ناجحة. */
export function bumpOnWrite(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !NON_DATA_WRITES.test(req.originalUrl)) {
    res.on('finish', () => { if (res.statusCode < 400) { dataVersion++; cache.clear(); } });
  }
  next();
}

function store(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

const send = (res, status, body, tag) => {
  res.set('X-Heavy-Cache', tag);
  res.status(status).type('application/json').send(body);
};

export function heavyGetCache(req, res, next) {
  if (req.method !== 'GET') return next();
  const path = req.originalUrl.split('?')[0];
  if (!HEAVY_PATHS.some(r => r.test(path))) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return next();

  const key = `${auth.slice(7)}|${req.originalUrl}`;
  const hit = cache.get(key);
  if (hit && hit.ver === dataVersion && Date.now() - hit.at < FRESH_MS) return send(res, hit.status, hit.body, 'hit');

  const pending = inflight.get(key);
  if (pending) {
    pending.then(r => {
      if (res.headersSent) return;
      if (r) send(res, r.status, r.body, 'shared');
      else next(); // الأول فشل — احسب مستقلاً
    });
    return;
  }

  const ver = dataVersion;
  let done;
  const p = new Promise(resolve => { done = resolve; });
  inflight.set(key, p);
  const finish = (r) => { if (inflight.get(key) === p) inflight.delete(key); done(r); };

  const origJson = res.json.bind(res);
  res.json = (obj) => {
    let body;
    try { body = JSON.stringify(obj); } catch { finish(null); return origJson(obj); }
    const status = res.statusCode || 200;
    const ok = status < 400 && body.length <= MAX_BODY;
    if (ok && ver === dataVersion) store(key, { at: Date.now(), ver, status, body });
    finish(ok ? { status, body } : null);
    res.set('X-Heavy-Cache', 'miss');
    return res.type('application/json').send(body);
  };
  // المتصفح ألغى الطلب: المعالج يكمل ويستدعي res.json فيُخبَّأ الرد. رد بلا res.json
  // (خطأ عبر send مثلاً) أو معالج عالق: المنتظرون يحسبون مستقلين بعد مهلة.
  res.on('finish', () => setTimeout(() => finish(null), 0));
  const guard = setTimeout(() => finish(null), 3 * 60 * 1000);
  p.then(() => clearTimeout(guard));
  next();
}
