// ════════════════════════════════════════════════════════════════════════════
// dofied.client.js — اتصال غير رسمي بموقع دوفايد (dofied.com) بحساب المستخدم نفسه:
// تسجيل دخول ثم تصدير تقارير الزيارات كإكسل، نفس ما يفعله المستخدم من المتصفح.
//
// المسارات مأخوذة من تسجيل جلسة حقيقية (HAR، 2026-11-09):
//   POST /login/logcheck.php           username, password  ← النص "true" عند النجاح
//   POST /dashboard/process/export_tasks.php  (فلاتر صفحة المهام) ← ملف xlsx
// غير رسمي: أي تحديث في موقعهم قد يكسره، فكل فشل يُرجع رسالة عربية واضحة.
// الدوال النقية مصدَّرة للاختبار (npm run test:dofied).
// ════════════════════════════════════════════════════════════════════════════

import XLSX from 'xlsx';

export const DOFIED_BASE = 'https://dofied.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 60_000;

export class DofiedError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ─── نقيّ ────────────────────────────────────────────────────────────────────

/** يدمج ترويسات Set-Cookie في جرّة {name: value}. */
export function mergeCookies(jar, setCookies) {
  for (const line of setCookies || []) {
    const [pair] = String(line).split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!value || /^deleted$/i.test(value)) delete jar[name];
    else jar[name] = value;
  }
  return jar;
}

export const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

/** رد تسجيل الدخول: النص «true» فقط يعني النجاح. */
export const loginOk = (body) => String(body ?? '').trim().toLowerCase() === 'true';

/** صفحة «Heavey Request! … Too many records» بدل الملف حين يكون المدى كبيراً. */
export const isTooMany = (html) => /too many records|heavey request|heavy request/i.test(String(html ?? ''));

/** ملف xlsx حقيقي يبدأ بتوقيع ZIP «PK». */
export const isXlsx = (buf) => Buffer.isBuffer(buf) && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;

/** أيام المدى من..إلى (YYYY-MM-DD) شاملة. */
export function daysBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * يدمج عدة ملفات تصدير في ملف واحد بنفس الأوراق («Tasks» ثم «Task Notes») — استيراد
 * الزيارات يقرأ الورقة الأولى ويربط ملاحظات الورقة الثانية بعمود id.
 */
export function mergeWorkbooks(buffers) {
  const sheets = new Map(); // name → { header, rows }
  for (const buf of buffers) {
    const wb = XLSX.read(buf);
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
      if (!rows.length) continue;
      if (!sheets.has(name)) sheets.set(name, { header: rows[0], rows: [] });
      sheets.get(name).rows.push(...rows.slice(1));
    }
  }
  const out = XLSX.utils.book_new();
  let total = 0;
  for (const [name, s] of sheets) {
    XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([s.header, ...s.rows]), name);
    if (total === 0) total = s.rows.length; // صفوف الورقة الأولى = الزيارات
  }
  if (!sheets.size) XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([[]]), 'Tasks');
  return { buffer: XLSX.write(out, { type: 'buffer', bookType: 'xlsx' }), taskRows: total };
}

// ─── شبكة ────────────────────────────────────────────────────────────────────

async function request(path, { method = 'GET', jar, form, referer } = {}) {
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.9' };
  if (jar && Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (referer) headers.Referer = `${DOFIED_BASE}${referer}`;
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    headers.Origin = DOFIED_BASE;
    body = new URLSearchParams(form).toString();
  }
  let res;
  try {
    res = await fetch(`${DOFIED_BASE}${path}`, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new DofiedError(`تعذّر الوصول لموقع دوفايد: ${e?.name === 'TimeoutError' ? 'انتهت المهلة' : e?.message}`, 'NETWORK');
  }
  if (jar) mergeCookies(jar, typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
  return res;
}

/** يسجّل الدخول ويُرجع جرّة الكوكيز للجلسة. */
export async function login(username, password) {
  if (!username || !password) throw new DofiedError('اسم المستخدم أو كلمة السر غير مضبوطين', 'NO_CREDENTIALS');
  const jar = {};
  await request('/login/', { jar }); // كوكي الجلسة الأولى إن وُجد
  const res = await request('/login/logcheck.php', {
    method: 'POST', jar, referer: '/login/', form: { username, password },
  });
  const text = await res.text().catch(() => '');
  if (res.status >= 500) throw new DofiedError(`موقع دوفايد لا يستجيب (HTTP ${res.status})`, 'UPSTREAM');
  if (!loginOk(text)) throw new DofiedError('رفض دوفايد تسجيل الدخول — تحقّق من اسم المستخدم وكلمة السر', 'LOGIN_FAILED');
  return jar;
}

/** تصدير المهام المكتملة المنشأة بين التاريخين. يرمي TOO_MANY حين يرفض الموقع المدى. */
export async function exportTasks(jar, from, to) {
  const filters = { d: 'yes', sdate: from, edate: to, f: 'yes', status: '1', datetype: 'created' };
  const res = await request('/dashboard/process/export_tasks.php', {
    method: 'POST', jar,
    referer: `/dashboard/index.php?page=tasks&${new URLSearchParams(filters)}`,
    form: { 'tasks-export-csv-btn': '', ...filters },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (isXlsx(buf)) return buf;
  const text = buf.toString('utf8');
  if (isTooMany(text)) throw new DofiedError(`سجلات كثيرة بين ${from} و${to}`, 'TOO_MANY');
  if (res.status >= 300 && res.status < 400) throw new DofiedError('انتهت جلسة دوفايد أو رُفض الدخول للتصدير', 'SESSION');
  throw new DofiedError(`رد غير متوقّع من تصدير دوفايد (HTTP ${res.status}): ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`, 'UNEXPECTED');
}

/** يصدّر المدى كاملاً، ويقسّمه يوماً بيوم إن رفضه الموقع لكثرة السجلات. */
export async function exportRange(jar, from, to) {
  try {
    return mergeWorkbooks([await exportTasks(jar, from, to)]);
  } catch (e) {
    if (e?.code !== 'TOO_MANY' || from === to) throw e;
  }
  const parts = [];
  for (const day of daysBetween(from, to)) parts.push(await exportTasks(jar, day, day));
  return mergeWorkbooks(parts);
}
