// ════════════════════════════════════════════════════════════════════════════
// wa-campaigns.service.js — «حملات واتساب»: عروض لقائمة أرقام (Excel) عبر رقم البوت
// الرسمي (Cloud API).
//
// قواعد Meta التي يبنى عليها كل شيء هنا:
//  • المبادرة بمراسلة شخص = قالب معتمد فقط (Marketing للعروض). النص الثابت في Meta،
//    والتطبيق يملأ المتغيّرات ({{1}} …) لكل مستلم: اسمه، الايتم، السعر، نص ثابت، أو
//    أي عمود من الإكسل.
//  • القوالب تُقرأ حيّة من Meta (WHATSAPP_WABA_IDS) — قالب جديد/معدّل يظهر بمجرد
//    اعتماده، بلا نشر. الحملة تحفظ نسخة من القالب لحظة إنشائها.
//  • كل رسالة مدفوعة ⇒ لا إعادة إرسال تلقائية لصف «غير مؤكد» بعد إعادة التشغيل.
//  • من يضغط «إيقاف العروض» (أو يكتب «ايقاف») يُضاف لـWaOptOut ولا تصله حملة بعدها.
//
// الإرسال تدريجي في الخلفية (صفّ كل ~300ms)، يتوقف/يُستأنف/يُلغى، ويُستأنف بعد
// إعادة التشغيل. حالات التسليم (وصلت/قُرئت/فشلت) تأتي من ويب-هوك الحالات.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { normalizeWaId } from '../../lib/waId.js';
import { sendRaw, whatsappToken, downloadMedia, whatsappEnabled } from '../whatsapp/whatsapp.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '../..');

const graphBase = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v23.0'}`;
const phoneNumberId = () => process.env.WHATSAPP_PHONE_NUMBER_ID || '';
// حساب واتساب للأعمال (WABA) الذي تُنشأ فيه القوالب. قد يظهر الرقم تحت أكثر من
// معرّف، فنقرأ القوالب من كلها وندمجها.
// الأول = الحساب الذي تُحاسَب عليه رسائل الرقم (فيه بيانات الكلفة) — تُنشأ القوالب فيه.
const wabaIds = () => String(process.env.WHATSAPP_WABA_IDS || '2450625762413533,2846484169079403')
  .split(',').map(s => s.trim()).filter(Boolean);
const primaryWaba = () => wabaIds()[0];

// السعر الرسمي لرسالة التسويق للعراق (جدول Meta 2026) — يُستعمل فقط إن لم تُرسَل رسائل
// تسويق بعد ليُحسب متوسطها الفعلي من فواتير الحساب.
export const IQ_MARKETING_RATE = 0.0341;
export const IQ_UTILITY_RATE = 0.0079;

export const MAX_RECIPIENTS = 5000;
const SEND_GAP_MS = 300;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Graph ───────────────────────────────────────────────────────────────────

async function graphGet(p) {
  const token = whatsappToken();
  if (!token) throw new AppError('البوت الرسمي غير مفعّل على الخادم (WHATSAPP_TOKEN)', 400);
  const res = await fetch(`${graphBase()}/${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AppError(`Meta: ${data?.error?.error_user_msg || data?.error?.message || `HTTP ${res.status}`}`, 502);
  return data;
}

// ─── القوالب ─────────────────────────────────────────────────────────────────

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const varsOf = (text) => [...new Set([...String(text || '').matchAll(VAR_RE)].map(m => m[1]))];

/**
 * قالب Meta ⇒ شكل مبسّط: header/body/footer/buttons + قائمة المتغيّرات المطلوبة
 * (key: h:1 رأس، b:1 أو b:name نص، u:0 رابط زر ديناميكي، c:0 كود نسخ).
 */
export function parseTemplate(t) {
  const comps = t.components || [];
  const H = comps.find(c => c.type === 'HEADER');
  const B = comps.find(c => c.type === 'BODY');
  const F = comps.find(c => c.type === 'FOOTER');
  const BT = comps.find(c => c.type === 'BUTTONS');
  const vars = [];
  let problem = null;

  const header = H ? { format: H.format, text: H.text || null } : null;
  if (H?.format === 'TEXT') for (const v of varsOf(H.text)) vars.push({ key: `h:${v}`, label: `الرأس {{${v}}}` });
  if (H && !['TEXT', 'IMAGE'].includes(H.format)) problem = `رأس القالب من نوع ${H.format} غير مدعوم (المدعوم: صورة أو نص)`;

  for (const v of varsOf(B?.text)) vars.push({ key: `b:${v}`, label: `{{${v}}}` });

  const buttons = (BT?.buttons || []).map((b, i) => {
    const out = { index: i, type: b.type, text: b.text, url: b.url || null, dynamic: false };
    if (b.type === 'URL' && varsOf(b.url).length) { out.dynamic = true; vars.push({ key: `u:${i}`, label: `رابط زر «${b.text}»` }); }
    if (b.type === 'COPY_CODE') { out.dynamic = true; vars.push({ key: `c:${i}`, label: `كود زر «${b.text}»` }); }
    if (b.type === 'FLOW' || b.type === 'CATALOG' || b.type === 'MPM') problem = problem || `زر من نوع ${b.type} غير مدعوم في الحملات`;
    return out;
  });

  return {
    id: t.id || null, name: t.name, language: t.language, category: t.category, status: t.status,
    rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
    quality: t.quality_score?.score || null,
    named: t.parameter_format === 'NAMED',
    header, body: B?.text || '', footer: F?.text || null, buttons, vars, problem,
  };
}

let tplCache = { at: 0, list: null };

/** كل القوالب من حسابات WABA (مدمجة بالاسم+اللغة). كاش دقيقة واحدة. */
export async function listTemplates({ fresh = false } = {}) {
  if (!fresh && tplCache.list && Date.now() - tplCache.at < 60_000) return tplCache.list;
  const seen = new Map();
  const errors = [];
  for (const id of wabaIds()) {
    try {
      let next = `${id}/message_templates?fields=id,name,language,status,category,components,parameter_format,rejected_reason,quality_score&limit=200`;
      for (let page = 0; next && page < 10; page++) {
        const d = await graphGet(next);
        for (const t of d.data || []) {
          const k = `${t.name}|${t.language}`;
          if (!seen.has(k)) seen.set(k, parseTemplate(t));
        }
        next = d.paging?.next ? d.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '') : null;
      }
    } catch (e) { errors.push(e.message); }
  }
  if (!seen.size && errors.length) throw new AppError(errors[0], 502);
  const list = [...seen.values()].sort((a, b) =>
    (a.category === 'MARKETING' ? 0 : 1) - (b.category === 'MARKETING' ? 0 : 1) || a.name.localeCompare(b.name));
  tplCache = { at: Date.now(), list };
  return list;
}

// ─── إنشاء/حذف القوالب من التطبيق (بدل WhatsApp Manager) ─────────────────────

async function graphSend(p, { method = 'POST', body, headers = {}, raw = false } = {}) {
  const token = whatsappToken();
  if (!token) throw new AppError('البوت الرسمي غير مفعّل على الخادم (WHATSAPP_TOKEN)', 400);
  const res = await fetch(`${graphBase()}/${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AppError(`Meta: ${data?.error?.error_user_msg || data?.error?.error_user_title || data?.error?.message || `HTTP ${res.status}`}`, 400);
  return data;
}

let appIdCache = null;
async function metaAppId() {
  if (process.env.WHATSAPP_APP_ID) return process.env.WHATSAPP_APP_ID;
  if (appIdCache) return appIdCache;
  const t = whatsappToken();
  const d = await graphGet(`debug_token?input_token=${encodeURIComponent(t)}`);
  appIdCache = d?.data?.app_id || null;
  if (!appIdCache) throw new AppError('تعذّر معرفة معرّف تطبيق Meta', 500);
  return appIdCache;
}

/** صورة مثال لرأس القالب — Meta تطلبها عبر Resumable Upload وتعيد header_handle. */
async function uploadSampleHandle(buffer, mime) {
  if (!['image/jpeg', 'image/png'].includes(mime)) throw new AppError('صورة المثال يجب أن تكون JPG أو PNG', 400);
  const appId = await metaAppId();
  const sess = await graphSend(`${appId}/uploads?file_name=sample.${mime === 'image/png' ? 'png' : 'jpg'}&file_length=${buffer.length}&file_type=${encodeURIComponent(mime)}`);
  const token = whatsappToken();
  const res = await fetch(`${graphBase()}/${sess.id}`, {
    method: 'POST', headers: { Authorization: `OAuth ${token}`, file_offset: '0' }, body: buffer,
  });
  const d = await res.json().catch(() => null);
  if (!res.ok || !d?.h) throw new AppError(`تعذّر رفع صورة المثال: ${d?.error?.message || res.status}`, 400);
  return d.h;
}

/**
 * ينشئ قالباً في Meta ويُرسله للمراجعة. body: { name, category, language, headerType
 * (none|image|text), headerText, bodyText, samples[], footer, buttons[] }.
 */
export async function createTemplate(body, imageFile) {
  const name = String(body.name || '').trim();
  if (!/^[a-z0-9_]{1,60}$/.test(name)) throw new AppError('اسم القالب: حروف إنكليزية صغيرة وأرقام و _ فقط (مثل item_offer)', 400);
  const category = ['MARKETING', 'UTILITY'].includes(body.category) ? body.category : 'MARKETING';
  const language = String(body.language || 'ar');
  const text = String(body.bodyText || '').trim();
  if (!text) throw new AppError('نص الرسالة فارغ', 400);
  if (text.length > 1024) throw new AppError('نص الرسالة أطول من 1024 حرفاً', 400);

  const nums = [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => Number(m[1]));
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  if (uniq.some((n, i) => n !== i + 1)) throw new AppError('المتغيّرات يجب أن تكون متسلسلة {{1}} {{2}} {{3}} … بلا قفز', 400);
  if (/^\s*\{\{/.test(text) || /\}\}\s*[.!؟?]?\s*$/.test(text)) throw new AppError('Meta ترفض نصاً يبدأ أو ينتهي بمتغيّر — أضف كلمة قبله/بعده', 400);
  if (/\{\{\s*\d+\s*\}\}\s*\{\{/.test(text)) throw new AppError('لا تضع متغيّرين متلاصقين — افصل بينهما بكلمة', 400);
  const samples = (body.samples || []).map(s => String(s ?? '').replace(/[\r\n]+/g, ' ').trim());
  if (uniq.length && (samples.length < uniq.length || samples.slice(0, uniq.length).some(s => !s))) throw new AppError('اكتب مثالاً لكل متغيّر', 400);

  const components = [];
  if (body.headerType === 'image') {
    if (!imageFile) throw new AppError('ارفع صورة مثال للرأس', 400);
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [await uploadSampleHandle(imageFile.buffer, imageFile.mimetype)] } });
  } else if (body.headerType === 'text' && String(body.headerText || '').trim()) {
    const ht = String(body.headerText).trim();
    if (ht.length > 60) throw new AppError('عنوان الرأس أطول من 60 حرفاً', 400);
    if (/\{\{/.test(ht)) throw new AppError('عنوان الرأس بلا متغيّرات هنا — اكتبه نصاً ثابتاً', 400);
    components.push({ type: 'HEADER', format: 'TEXT', text: ht });
  }
  components.push({ type: 'BODY', text, ...(uniq.length ? { example: { body_text: [samples.slice(0, uniq.length)] } } : {}) });
  const footer = String(body.footer || '').trim();
  if (footer) {
    if (footer.length > 60) throw new AppError('سطر التذييل أطول من 60 حرفاً', 400);
    components.push({ type: 'FOOTER', text: footer });
  }
  const buttons = (body.buttons || []).map(b => String(b || '').trim()).filter(Boolean);
  if (buttons.length > 3) throw new AppError('3 أزرار كحد أقصى', 400);
  if (buttons.some(b => b.length > 25)) throw new AppError('نص الزر 25 حرفاً كحد أقصى', 400);
  if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons.map(t => ({ type: 'QUICK_REPLY', text: t })) });

  const d = await graphSend(`${primaryWaba()}/message_templates`, { body: { name, language, category, components } });
  tplCache = { at: 0, list: null };
  return { id: d.id, status: d.status, category: d.category };
}

/** حذف قالب — التسويقية فقط (الخدمية مثل new_order يعتمد عليها إرسال المذاخر). */
export async function deleteTemplate(name) {
  const t = (await listTemplates({ fresh: true })).find(x => x.name === name);
  if (!t) throw new AppError('القالب غير موجود', 404);
  if (t.category !== 'MARKETING') throw new AppError('يُحذف من هنا القوالب التسويقية فقط', 400);
  const busy = await prisma.waCampaign.count({ where: { templateName: name, status: { in: ['sending', 'paused', 'draft'] } } });
  if (busy) throw new AppError('حملة جارية/مسودة تستعمل هذا القالب — ألغها أولاً', 400);
  await graphSend(`${primaryWaba()}/message_templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
  tplCache = { at: 0, list: null };
}

// ─── الكلفة الفعلية من Meta (pricing_analytics) ──────────────────────────────

let costCache = new Map();

/** حجم وكلفة الرسائل المدفوعة يومياً حسب الفئة والدولة. days ≤ 90. */
export async function costReport(days = 30) {
  days = Math.min(90, Math.max(1, Number(days) || 30));
  const hit = costCache.get(days);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const fields = `pricing_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE","COUNTRY"])`;
  const d = await graphGet(`${primaryWaba()}?fields=${encodeURIComponent(fields)}`);
  const points = (d.pricing_analytics?.data || []).flatMap(x => x.data_points || []);
  const rows = points.map(p => ({
    date: new Date(p.start * 1000).toISOString().slice(0, 10),
    category: String(p.pricing_category || '').toLowerCase(),
    type: String(p.pricing_type || '').toLowerCase(),
    country: p.country || null,
    volume: Number(p.volume) || 0,
    cost: Number(p.cost) || 0,
  })).sort((a, b) => b.date.localeCompare(a.date));
  const byCat = {};
  for (const r of rows) {
    const k = r.category || 'other';
    byCat[k] ||= { volume: 0, cost: 0 };
    byCat[k].volume += r.volume; byCat[k].cost += r.cost;
  }
  const data = { days, currency: 'USD', rows, byCategory: byCat, totalCost: rows.reduce((s, r) => s + r.cost, 0) };
  costCache.set(days, { at: Date.now(), data });
  return data;
}

/** سعر رسالة التسويق الفعلي (متوسط آخر 90 يوماً) وإلا السعر الرسمي للعراق. */
export async function marketingPrice() {
  try {
    const r = await costReport(90);
    const m = r.byCategory.marketing;
    if (m?.volume > 0 && m.cost > 0) return { value: m.cost / m.volume, source: 'actual', volume: m.volume };
  } catch {}
  return { value: IQ_MARKETING_RATE, source: 'rate' };
}

/** حدّ الإرسال اليومي وجودة الرقم — للعرض فقط، فشلها لا يمنع الصفحة. */
export async function phoneInfo() {
  try {
    const d = await graphGet(`${phoneNumberId()}?fields=display_phone_number,verified_name,quality_rating,whatsapp_business_manager_messaging_limit`);
    const tier = d.whatsapp_business_manager_messaging_limit || null;
    const TIERS = { TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: null };
    return { phone: d.display_phone_number, name: d.verified_name, quality: d.quality_rating, tier, dailyLimit: tier in TIERS ? TIERS[tier] : null };
  } catch (e) { return { error: e.message }; }
}

// ─── صورة الرأس ──────────────────────────────────────────────────────────────

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/** رفع صورة لواتساب ⇒ media id (صالح ~30 يوماً). واتساب يقبل JPEG/PNG فقط للرأس. */
export async function uploadMedia(buffer, mime) {
  if (!whatsappEnabled()) throw new AppError('البوت الرسمي غير مفعّل على الخادم', 400);
  if (!['image/jpeg', 'image/png'].includes(mime)) throw new AppError('الصورة يجب أن تكون JPG أو PNG', 400);
  if (buffer.length > 5 * 1024 * 1024) throw new AppError('حجم الصورة أكبر من 5MB', 400);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), mime === 'image/png' ? 'offer.png' : 'offer.jpg');
  const res = await fetch(`${graphBase()}/${phoneNumberId()}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${whatsappToken()}` }, body: form,
  });
  const d = await res.json().catch(() => null);
  if (!res.ok || !d?.id) throw new AppError(`تعذّر رفع الصورة لواتساب: ${d?.error?.message || res.status}`, 502);
  return d.id;
}

export async function uploadItemImage(itemId) {
  const item = await prisma.item.findUnique({ where: { id: Number(itemId) }, select: { imageUrl: true } });
  if (!item?.imageUrl) throw new AppError('لا توجد صورة لهذا الايتم', 404);
  const file = path.join(SERVER_DIR, item.imageUrl.replace(/^\/+/, ''));
  if (!file.startsWith(SERVER_DIR) || !fs.existsSync(file)) throw new AppError('ملف صورة الايتم غير موجود على الخادم', 404);
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (mime === 'image/webp') throw new AppError('صورة الايتم بصيغة WEBP — ارفع صورة JPG أو PNG بدلها', 400);
  return uploadMedia(fs.readFileSync(file), mime);
}

export const campaignImage = async (c) => {
  if (!c.headerMediaId) throw new AppError('لا صورة لهذه الحملة', 404);
  return downloadMedia(c.headerMediaId);
};

// ─── المتغيّرات والرسالة ─────────────────────────────────────────────────────

const fmtNum = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-US'));
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// واتساب يرفض متغيّراً فارغاً أو فيه أسطر جديدة/أكثر من 4 مسافات
const flat = (v, max = 900) => clip(String(v ?? '').replace(/[\r\n\t]+/g, ' • ').replace(/ {4,}/g, '   ').trim(), max) || '—';

/** قيمة متغيّر واحد لمستلم واحد. ctx = { name, extra, item:{name,price,warehousePrice} } */
export function resolveVar(m, ctx) {
  const v = m?.value ?? '';
  switch (m?.source) {
    case 'name': return String(ctx.name || '').trim() || String(v || '').trim() || 'عميلنا العزيز';
    case 'item': return ctx.item?.name || v;
    case 'price': return ctx.item?.price != null ? fmtNum(ctx.item.price) : v;
    case 'warehousePrice': return ctx.item?.warehousePrice != null ? fmtNum(ctx.item.warehousePrice) : v;
    case 'col': return ctx.extra?.[v] ?? '';
    default: return v;
  }
}

/** نصّ القالب كما سيصل (للمعاينة والسجل). */
export function renderPreview(tpl, varMap, ctx) {
  const map = new Map((varMap || []).map(m => [m.key, m]));
  const fill = (text, prefix) => String(text || '').replace(VAR_RE, (_, k) => {
    const m = map.get(`${prefix}:${k}`);
    return m ? flat(resolveVar(m, ctx)) : `{{${k}}}`;
  });
  return {
    header: tpl.header?.format === 'TEXT' ? fill(tpl.header.text, 'h') : null,
    body: fill(tpl.body, 'b'),
    footer: tpl.footer,
    buttons: tpl.buttons.map(b => b.text),
  };
}

/** حمولة القالب لـCloud API. */
function buildTemplatePayload(c, tpl, varMap, r) {
  const map = new Map((varMap || []).map(m => [m.key, m]));
  const ctx = { name: r.name, extra: r.extra ? safeJson(r.extra, {}) : {}, item: { name: c.itemName, price: c.itemPrice, warehousePrice: c.itemWarehousePrice } };
  const val = (key) => flat(resolveVar(map.get(key), ctx));
  const components = [];

  if (tpl.header?.format === 'IMAGE') {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { id: c.headerMediaId } }] });
  } else if (tpl.header?.format === 'TEXT') {
    const hv = varsOf(tpl.header.text);
    if (hv.length) components.push({ type: 'header', parameters: hv.map(k => ({ type: 'text', text: clip(val(`h:${k}`), 60), ...(tpl.named ? { parameter_name: k } : {}) })) });
  }
  const bv = varsOf(tpl.body);
  if (bv.length) components.push({ type: 'body', parameters: bv.map(k => ({ type: 'text', text: val(`b:${k}`), ...(tpl.named ? { parameter_name: k } : {}) })) });

  for (const b of tpl.buttons) {
    if (b.type === 'QUICK_REPLY') {
      components.push({ type: 'button', sub_type: 'quick_reply', index: String(b.index), parameters: [{ type: 'payload', payload: `wc:${r.id || 0}:${b.index}` }] });
    } else if (b.type === 'URL' && b.dynamic) {
      components.push({ type: 'button', sub_type: 'url', index: String(b.index), parameters: [{ type: 'text', text: clip(val(`u:${b.index}`), 200) }] });
    } else if (b.type === 'COPY_CODE') {
      components.push({ type: 'button', sub_type: 'copy_code', index: String(b.index), parameters: [{ type: 'coupon_code', coupon_code: clip(val(`c:${b.index}`), 15) }] });
    }
  }
  return { type: 'template', template: { name: c.templateName, language: { code: c.templateLang }, components } };
}

function safeJson(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

// ─── أخطاء Meta ──────────────────────────────────────────────────────────────

const ERR_AR = {
  131026: 'الرقم ليس عليه واتساب أو تعذّر التسليم',
  131049: 'Meta لم تسلّمها (حدّ رسائل التسويق لهذا الشخص — طبيعي)',
  131050: 'المستلم أوقف رسائل التسويق منكم من واتساب',
  131051: 'نوع رسالة غير مدعوم',
  131052: 'تعذّر تنزيل الصورة',
  131053: 'تعذّر رفع الصورة',
  131042: 'مشكلة في وسيلة الدفع بحساب Meta',
  131048: 'تقييد Meta بسبب جودة الرقم (بلاغات/حظر)',
  131056: 'رسائل كثيرة لنفس الرقم بوقت قصير',
  130429: 'تجاوز سرعة الإرسال المسموحة',
  130472: 'الرقم ضمن تجربة Meta — لم تُسلَّم',
  132000: 'عدد متغيّرات القالب لا يطابق القالب في Meta',
  132001: 'القالب غير موجود أو غير معتمد بهذه اللغة',
  132005: 'نص القالب بعد التعبئة أطول من المسموح',
  132007: 'محتوى المتغيّرات يخالف سياسة Meta',
  132012: 'صيغة متغيّرات القالب غير صحيحة',
  132015: 'القالب موقوف من Meta (جودة منخفضة)',
  132016: 'القالب معطّل نهائياً من Meta',
  131008: 'متغيّر مطلوب ناقص',
  131009: 'قيمة متغيّر غير صالحة',
};
// أخطاء تخصّ الحملة كلها لا المستلم ⇒ إيقاف مؤقت بدل إفشال كل الأرقام
const FATAL = new Set([132000, 132001, 132005, 132012, 132015, 132016, 131008, 131009, 131042, 131053, 190, 10, 100, 200, 368, 'NO_TOKEN']);
const RETRY = new Set([130429, 131056, 'NETWORK', 1, 2, 4, 80007, 131000]);

const errText = (e) => {
  const code = e?.code;
  return `${code ? `[${code}] ` : ''}${ERR_AR[code] || e?.message || e?.title || 'فشل الإرسال'}`;
};

// ─── الحالة والعدّادات ───────────────────────────────────────────────────────

export async function campaignCounts(ids) {
  if (!ids.length) return new Map();
  const [byStatus, byReply, billable] = await Promise.all([
    prisma.waCampaignRecipient.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: ids } }, _count: { _all: true } }),
    prisma.waCampaignRecipient.groupBy({ by: ['campaignId', 'reply'], where: { campaignId: { in: ids }, reply: { not: null } }, _count: { _all: true } }),
    prisma.waCampaignRecipient.groupBy({ by: ['campaignId'], where: { campaignId: { in: ids }, billable: true }, _count: { _all: true } }),
  ]);
  const out = new Map(ids.map(id => [id, { pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, order: 0, visit: 0, stop: 0, text: 0, button: 0, billable: 0 }]));
  for (const g of byStatus) out.get(g.campaignId)[g.status] = g._count._all;
  for (const g of byReply) out.get(g.campaignId)[g.reply] = g._count._all;
  for (const g of billable) out.get(g.campaignId).billable = g._count._all;
  return out;
}

export async function isOptedOut(waId) {
  return Boolean(await prisma.waOptOut.findUnique({ where: { waId: String(waId) } }));
}

export async function addOptOut(waId, source, campaignId = null) {
  const id = normalizeWaId(waId);
  if (!id) return;
  await prisma.waOptOut.upsert({ where: { waId: id }, create: { waId: id, source, campaignId }, update: {} });
  // ما لم يُرسل بعد في الحملات الجارية لا يُرسل
  await prisma.waCampaignRecipient.updateMany({ where: { waId: id, status: 'pending' }, data: { status: 'skipped', error: 'طلب إيقاف العروض' } });
}

// ─── المحرّك ─────────────────────────────────────────────────────────────────

const running = new Set();

/** يبدأ (أو يتابع) إرسال حملة في الخلفية — آمن للاستدعاء المتكرر. */
export function kickCampaign(id) {
  id = Number(id);
  if (running.has(id)) return;
  running.add(id);
  runCampaign(id)
    .catch(async (e) => {
      console.error(`[wa-campaigns] #${id} توقّف:`, e);
      await prisma.waCampaign.update({ where: { id }, data: { status: 'paused', lastError: `خطأ داخلي: ${e.message}` } }).catch(() => {});
    })
    .finally(() => running.delete(id));
}

async function runCampaign(id) {
  let c = await prisma.waCampaign.findUnique({ where: { id } });
  if (!c || c.status !== 'sending') return;
  const tpl = safeJson(c.templateSnapshot, null);
  const varMap = safeJson(c.varMap, []);
  if (!tpl) throw new Error('نسخة القالب تالفة');
  const sentBy = { id: c.createdById, name: c.createdByName ? `حملة: ${c.title}` : null };

  for (;;) {
    const batch = await prisma.waCampaignRecipient.findMany({ where: { campaignId: id, status: 'pending' }, orderBy: { id: 'asc' }, take: 25 });
    if (!batch.length) {
      await prisma.waCampaign.updateMany({ where: { id, status: 'sending' }, data: { status: 'done', finishedAt: new Date() } });
      console.log(`[wa-campaigns] #${id} اكتملت`);
      return;
    }
    for (const r of batch) {
      c = await prisma.waCampaign.findUnique({ where: { id }, select: { status: true } });
      if (c?.status !== 'sending') return; // أُوقفت أو أُلغيت

      if (await isOptedOut(r.waId)) {
        await prisma.waCampaignRecipient.update({ where: { id: r.id }, data: { status: 'skipped', error: 'طلب إيقاف العروض' } });
        continue;
      }
      const claimed = await prisma.waCampaignRecipient.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'sending' } });
      if (!claimed.count) continue;

      const full = await prisma.waCampaign.findUnique({ where: { id } });
      const payload = buildTemplatePayload(full, tpl, varMap, r);
      let res = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await sendRaw(r.waId, payload, { kind: 'template', sentBy });
        if (res.id || !RETRY.has(res.error?.code)) break;
        await sleep(5000 * (attempt + 1));
      }

      if (res.id) {
        await prisma.waCampaignRecipient.update({ where: { id: r.id }, data: { status: 'sent', waMessageId: res.id, sentAt: new Date(), error: null } });
      } else if (FATAL.has(res.error?.code)) {
        // مشكلة في القالب/الحساب — كل الأرقام الباقية ستفشل بنفس السبب
        await prisma.waCampaignRecipient.update({ where: { id: r.id }, data: { status: 'pending' } });
        await prisma.waCampaign.update({ where: { id }, data: { status: 'paused', lastError: errText(res.error) } });
        console.warn(`[wa-campaigns] #${id} أُوقفت: ${errText(res.error)}`);
        return;
      } else {
        await prisma.waCampaignRecipient.update({ where: { id: r.id }, data: { status: 'failed', error: errText(res.error) } });
        if (res.error?.code === 131050) await addOptOut(r.waId, 'meta', id);
      }
      await sleep(SEND_GAP_MS);
    }
  }
}

/** عند الإقلاع: صفوف كانت «قيد الإرسال» لحظة الانقطاع لا تُعاد (قد تكون أُرسلت وهي مدفوعة). */
export async function resumeCampaigns() {
  const live = await prisma.waCampaign.findMany({ where: { status: 'sending' }, select: { id: true } });
  if (!live.length) return 0;
  await prisma.waCampaignRecipient.updateMany({
    where: { campaignId: { in: live.map(c => c.id) }, status: 'sending' },
    data: { status: 'failed', error: 'انقطع الإرسال بإعادة تشغيل الخادم — غير مؤكد' },
  });
  for (const c of live) kickCampaign(c.id);
  return live.length;
}

// ─── الويب-هوك ───────────────────────────────────────────────────────────────

const RANK = { pending: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

/** حالة رسالة (sent/delivered/read/failed). يعيد true إن كانت رسالة حملة. */
export async function handleCampaignStatus(st) {
  if (!st?.id) return false;
  const r = await prisma.waCampaignRecipient.findFirst({ where: { waMessageId: String(st.id) } });
  if (!r) return false;
  const now = new Date();
  // Meta تُرفق pricing بحالة sent/delivered: هل الرسالة محتسبة (مدفوعة) وفئتها
  if (st.pricing && (r.billable === null || r.billable === undefined)) {
    await prisma.waCampaignRecipient.update({
      where: { id: r.id },
      data: { billable: st.pricing.billable !== false, pricingCategory: st.pricing.category || null },
    }).catch(() => {});
  }
  if (st.status === 'failed') {
    const e = st.errors?.[0];
    await prisma.waCampaignRecipient.update({ where: { id: r.id }, data: { status: 'failed', error: errText({ code: e?.code, message: e?.error_data?.details || e?.title || e?.message }) } });
    if (e?.code === 131050) await addOptOut(r.waId, 'meta', r.campaignId);
    return true;
  }
  if ((RANK[st.status] ?? -1) > (RANK[r.status] ?? 99)) {
    await prisma.waCampaignRecipient.update({
      where: { id: r.id },
      data: {
        status: st.status,
        ...(st.status === 'delivered' ? { deliveredAt: now } : {}),
        ...(st.status === 'read' ? { readAt: now, deliveredAt: r.deliveredAt || now } : {}),
      },
    });
  }
  return true;
}

const STOP_BTN_RE = /إيقاف|ايقاف|توقف|توقيف|الغاء|إلغاء|stop|unsubscribe/i;
const STOP_TEXT_RE = /^\s*(إيقاف|ايقاف|توقف|توقيف|stop|الغاء الاشتراك|إلغاء الاشتراك)(\s+العروض)?\s*[.!]?\s*$/i;
const ORDER_BTN_RE = /اطلب|طلب|احجز|اشتري|أريد|اريد|order|buy/i;
const VISIT_BTN_RE = /زيار|زياره|visit/i;
const REPLY_RANK = { text: 1, button: 2, visit: 3, order: 4 };
const DEFAULT_REPLY = 'شكراً لاهتمامك 🌷 تم تسجيل طلبك وسيتواصل معك فريقنا قريباً.';
const VISIT_REPLY = 'سيزوركم مندوبنا إلى الصيدلية قريباً، مع التقدير 🌷';
const STOP_REPLY = 'تم إيقاف العروض ✅ لن تصلك رسائل عروض منّا بعد الآن.';

/** ضغطة زر على قالب حملة. يعيد true إن عولجت هنا. */
export async function handleCampaignButton(message, { sendText }) {
  if (message?.type !== 'button') return false;
  const payload = String(message.button?.payload || '');
  const text = String(message.button?.text || '');
  let r = null;
  if (message.context?.id) r = await prisma.waCampaignRecipient.findFirst({ where: { waMessageId: String(message.context.id) } });
  if (!r) {
    const m = payload.match(/^wc:(\d+):/);
    if (m && Number(m[1])) r = await prisma.waCampaignRecipient.findUnique({ where: { id: Number(m[1]) } });
  }
  if (!r && !payload.startsWith('wc:')) return false;
  const waId = String(message.from);

  if (STOP_BTN_RE.test(text)) {
    await addOptOut(waId, 'button', r?.campaignId ?? null);
    if (r) await prisma.waCampaignRecipient.update({ where: { id: r.id }, data: { reply: 'stop', replyText: text, repliedAt: new Date() } });
    await sendText(waId, STOP_REPLY);
    return true;
  }
  if (!r) return true;
  // «زيارة المندوب» قبل «طلب» — نصّه قد يحوي كلمة «طلب»
  const kind = VISIT_BTN_RE.test(text) ? 'visit' : ORDER_BTN_RE.test(text) ? 'order' : 'button';
  // الأهم لا يُستبدل بردّ لاحق أقل أهمية: طلب > زيارة > ضغطة > نص
  if ((REPLY_RANK[kind] ?? 0) >= (REPLY_RANK[r.reply] ?? 0)) {
    await prisma.waCampaignRecipient.update({ where: { id: r.id }, data: { reply: kind, replyText: text, repliedAt: new Date() } });
  }
  if (kind === 'visit') { await sendText(waId, VISIT_REPLY); return true; }
  const c = await prisma.waCampaign.findUnique({ where: { id: r.campaignId }, select: { replyText: true } });
  await sendText(waId, c?.replyText?.trim() || DEFAULT_REPLY);
  return true;
}

/**
 * رسالة حرّة (نص/صورة) من رقم وصلته حملة خلال 30 يوماً وليس مربوطاً بحساب: تُسجَّل
 * كردّ على الحملة بدل «هذا الرقم غير مربوط». «ايقاف» وحدها ⇒ إيقاف العروض.
 */
export async function absorbCampaignReply(message, { sendText }) {
  const waId = String(message?.from || '');
  if (!waId) return false;
  const link = await prisma.whatsAppChatLink.findUnique({ where: { waId }, select: { id: true } });
  if (link) return false;
  const r = await prisma.waCampaignRecipient.findFirst({
    where: { waId, sentAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    orderBy: { sentAt: 'desc' },
  });
  if (!r) return false;
  const body = message.type === 'text' ? String(message.text?.body || '') : `[${message.type}]`;
  if (message.type === 'text' && STOP_TEXT_RE.test(body)) {
    await addOptOut(waId, 'text', r.campaignId);
    await prisma.waCampaignRecipient.update({ where: { id: r.id }, data: { reply: 'stop', replyText: body.slice(0, 500), repliedAt: new Date() } });
    await sendText(waId, STOP_REPLY);
    return true;
  }
  if (!r.reply || r.reply === 'text') {
    await prisma.waCampaignRecipient.update({ where: { id: r.id }, data: { reply: 'text', replyText: body.slice(0, 500), repliedAt: new Date() } });
  }
  return true;
}

// ─── إنشاء وتجربة ────────────────────────────────────────────────────────────

/** يتحقق من القالب والمتغيّرات والصورة ويرجع ما يُحفظ في الحملة. */
export async function prepareCampaign(body) {
  const title = String(body.title || '').trim();
  if (!title) throw new AppError('اكتب اسماً للحملة', 400);
  const tpl = (await listTemplates({ fresh: true })).find(t => t.name === body.templateName && t.language === body.templateLang);
  if (!tpl) throw new AppError('القالب غير موجود في Meta — حدّث القائمة', 400);
  if (tpl.status !== 'APPROVED') throw new AppError(`القالب غير معتمد بعد (${tpl.status})`, 400);
  if (tpl.problem) throw new AppError(tpl.problem, 400);
  if (tpl.header?.format === 'IMAGE' && !body.headerMediaId) throw new AppError('هذا القالب يحتاج صورة — اختر صورة الايتم أو ارفع صورة', 400);

  const allowed = new Set(['name', 'item', 'price', 'warehousePrice', 'text', 'col']);
  const varMap = tpl.vars.map(v => {
    const m = (body.varMap || []).find(x => x.key === v.key) || {};
    if (!allowed.has(m.source)) throw new AppError(`حدّد قيمة للمتغيّر ${v.label}`, 400);
    if (['text', 'col'].includes(m.source) && !String(m.value || '').trim()) throw new AppError(`المتغيّر ${v.label} فارغ`, 400);
    return { key: v.key, source: m.source, value: String(m.value ?? '').slice(0, 900) };
  });

  let item = null;
  if (body.itemId) {
    item = await prisma.item.findUnique({ where: { id: Number(body.itemId) }, select: { id: true, name: true, price: true, warehousePrice: true } });
    if (!item) throw new AppError('الايتم غير موجود', 400);
  }
  if (varMap.some(m => ['item', 'price', 'warehousePrice'].includes(m.source)) && !item) throw new AppError('اختر الايتم — القالب يستعمل اسمه أو سعره', 400);

  return {
    tpl,
    data: {
      title: title.slice(0, 120),
      templateName: tpl.name,
      templateLang: tpl.language,
      templateSnapshot: JSON.stringify(tpl),
      varMap: JSON.stringify(varMap),
      headerMediaId: tpl.header?.format === 'IMAGE' ? String(body.headerMediaId) : null,
      itemId: item?.id ?? null,
      itemName: item?.name ?? null,
      itemPrice: item?.price ?? null,
      itemWarehousePrice: item?.warehousePrice ?? null,
      replyText: String(body.replyText || '').trim().slice(0, 1000) || null,
    },
  };
}

/** يوحّد ويصفّي قائمة المستلمين. */
export function cleanRecipients(list) {
  const out = new Map();
  for (const r of Array.isArray(list) ? list : []) {
    const waId = normalizeWaId(r?.waId ?? r?.phone);
    if (!/^\d{10,15}$/.test(waId) || out.has(waId)) continue;
    const extra = r?.extra && typeof r.extra === 'object' ? r.extra : null;
    out.set(waId, { waId, name: String(r?.name ?? '').trim().slice(0, 120) || null, extra: extra ? JSON.stringify(extra).slice(0, 4000) : null });
  }
  return [...out.values()];
}

/** رسالة تجربة لرقم واحد بنفس إعداد الحملة (لا تُحفظ مستلماً). */
export async function sendTest(body, sentBy) {
  const waId = normalizeWaId(body.waId);
  if (!/^\d{10,15}$/.test(waId)) throw new AppError('رقم التجربة غير صالح', 400);
  const { tpl, data } = await prepareCampaign(body);
  const sample = cleanRecipients([{ waId, name: body.sample?.name, extra: body.sample?.extra }])[0];
  const r = { id: 0, waId, name: sample?.name ?? null, extra: sample?.extra ?? null };
  const res = await sendRaw(waId, buildTemplatePayload(data, tpl, safeJson(data.varMap, []), r), { kind: 'template', sentBy });
  if (!res.id) throw new AppError(`فشلت التجربة: ${errText(res.error)}`, 400);
  return { messageId: res.id };
}
