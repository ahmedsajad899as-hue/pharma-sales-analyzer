// ════════════════════════════════════════════════════════════════════════════
// dispatch.core.js — إرسال الطلبيات للمذاخر واستقبال ردّها (warehouse-dispatch).
//
// الدورة: طلبية تصل (بوت الطلبيات أو صفحة طلبيات المذاخر) ← صفّ WarehouseDispatch
// لكل (صيدلية × مذخر) ← يُرسَل لواتساب المذخر ← المذخر يضغط زراً (تجهيز/جزئي/رفض)
// أو يرسل صورة الفاتورة ← تتغيّر الحالة ويُشعَر المندوب في محادثته.
//
// قناتان للمذخر (OrderWarehouse.channel):
//  • cloud — رقم البوت الرسمي (Cloud API). داخل نافذة الـ24 ساعة (آخر رسالة من
//    المذخر) نرسل رسالة أزرار حرّة (service: أول 1000 شهرياً مجانية)؛ خارجها قالب
//    معتمد (template: مدفوع). إن ظنّنا النافذة مفتوحة وردّ واتساب 131047 نعيد بقالب.
//  • group — كروب واتساب عبر «رقم الكروبات» (wa-groups). نصّ الطلبية فقط (بلا تصويت منذ
//    2026-11-10 بطلب صاحب المشروع): المذخر يردّ عليها بصورة الفاتورة، والقراءة الذكية
//    (ببطاقة المذخر المعروف من الكروب) تقارنها بالطلبية فتقرّر «مجهّزة» أو «جزئية».
//    الردّ النصّي («تم/جزئي/رفض») ما زال يُفهم.
//
// الوضع لكل حساب (WarehouseDispatchSetting): off | auto (فوراً) | approval (بعد
// موافقة المدير من صفحة الإرسال، ويمكنه تغيير المذخر قبل الإرسال).
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import { normalizeArabic } from '../../lib/itemResolver.js';
import { normalizeWaId } from '../../lib/waId.js';
import { warehouseScopeWhere, canDispatchOrders } from '../rep-orders/rep-orders.service.js';
import { sendButtons, sendTemplate, sendWhatsAppText, whatsappEnabled } from '../whatsapp/whatsapp.service.js';
import { sendGroupText } from '../wa-groups/wa-groups.client.js';
import { withParty } from '../whatsapp/wa-chat-log.js';
import { compareInvoiceLines } from '../rep-orders/rep-orders.invoice.js';
import { isPdf } from '../../lib/invoicePdf.js';
import { recordPreparation, markSent } from '../rep-orders/rep-orders.service.js';
import { notifyOrigin } from './dispatch.notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// جذر المشروع/uploads — Nginx يخدم /uploads/ منه مباشرةً (لا من server/uploads)
export const DISPATCH_DIR = path.join(__dirname, '..', '..', '..', 'uploads', 'dispatch');

export const MODES = ['off', 'auto', 'approval'];
// حالات لم تُرسَل بعد — يجوز تعديل المذخر/الأسطر فيها
export const PRE_SEND = ['needs_warehouse', 'awaiting_approval', 'failed'];
// أُرسلت وتنتظر ردّاً أو فاتورة
export const OPEN_AT_WAREHOUSE = ['sent', 'prepared', 'partial', 'no_response'];

// نافذة الـ24 ساعة بهامش أمان: لا نخاطر برسالة حرّة قرب نهايتها
const WINDOW_MS = 23 * 60 * 60 * 1000;
const templateName = () => process.env.WHATSAPP_DISPATCH_TEMPLATE || 'new_order';
const templateLang = () => process.env.WHATSAPP_DISPATCH_TEMPLATE_LANG || 'ar';

export const ACTION_LABEL = { prepared: 'تم التجهيز', partial: 'تجهيز جزئي', rejected: 'رفض' };
// تصويتات الكروب القديمة (أُرسلت قبل 2026-11-10) — ما زالت أصواتها تُفهم. الترتيب = رقم الخيار.
export const GROUP_POLL_ACTIONS = ['prepared', 'partial', 'rejected'];

// ─── الإعدادات ───────────────────────────────────────────────────────────────

export async function getConfig() {
  return (await prisma.warehouseDispatchConfig.findUnique({ where: { id: 1 } }))
    || { id: 1, responseTimeoutMin: 120, autoBackup: true };
}

export async function getUserMode(userId) {
  const s = await prisma.warehouseDispatchSetting.findUnique({ where: { userId: Number(userId) } });
  return MODES.includes(s?.mode) ? s.mode : 'off';
}

// ─── مطابقة المذخر ───────────────────────────────────────────────────────────

const whKey = (s) => normalizeArabic(String(s ?? '').replace(/مذخر|مذاخر|شركة/g, ' ')).replace(/\s+/g, '');

/** المذخر الذي كتبه المندوب ← صفّ في دليل المذاخر ضمن نطاق حسابه. */
export async function matchWarehouse(name, owner) {
  const key = whKey(name);
  if (!key || !owner) return null;
  const list = await prisma.orderWarehouse.findMany({ where: await warehouseScopeWhere(owner), orderBy: { id: 'asc' } });
  const exact = list.find(w => whKey(w.name) === key);
  if (exact) return exact;
  const partial = list.filter(w => { const k = whKey(w.name); return k.length >= 3 && (k.includes(key) || key.includes(k)); });
  return partial.length === 1 ? partial[0] : null;
}

/** المذخر جاهز للإرسال الآلي على قناته؟ */
export function warehouseReady(w) {
  if (!w) return false;
  // groupSendOn = مفتاح «الإرسال الآلي» للمذخر على أي قناة (لوحة الماستر «المذاخر والبوت»، وفي
  // «رقم الكروبات» لكروب المذخر). مطفأ ⇒ لا إرسال آلي من أي مسار (فوري/موافقة/تحويل/بديل)
  if (w.groupSendOn === false) return false;
  if (w.channel === 'group') return Boolean(w.groupJid);
  if (w.channel === 'manual') return false;
  return Boolean(normalizeWaId(w.waId || w.phone));
}

export { warehouseBotVia } from '../../lib/warehouseBotVia.js';

/** سبب عدم جاهزية المذخر للإرسال — نصّ للمستخدم. */
export function notReadyReason(w) {
  if (w?.groupSendOn === false) return 'الإرسال الآلي لهذا المذخر موقوف (لوحة الماستر) — أرسلها يدوياً';
  if (w?.channel === 'group') return 'لم يُختر كروب لهذا المذخر';
  return 'المذخر بلا رقم واتساب أو مضبوط على «يدوي»';
}

// ─── نصّ الطلبية ─────────────────────────────────────────────────────────────

const fmtQty = (n) => (Number.isFinite(Number(n)) ? String(Math.round(Number(n))) : '—');

export function lineText(l, i) {
  const bonus = Number(l.bonus) > 0 ? ` + ${fmtQty(l.bonus)} بونص` : '';
  return `${i + 1}) ${l.item} — ${fmtQty(l.quantity)}${bonus}`;
}

/**
 * نص الكروب: كأن شخصاً كتبه — بلا أيقونات ولا رقم طلبية ولا اسم المندوب ولا طلب الرد بالفاتورة
 * (طلب صاحب المشروع). المطابقة لا تحتاج الرقم: الرد يُعرف من معرّف الرسالة، والفاتورة بقراءتها.
 */
function buildGroupOrderText(d) {
  const lines = Array.isArray(d.lines) ? d.lines : [];
  const ph = String(d.pharmacyName || '').trim();
  const head = ph ? (/^صيدلي/.test(ph) ? ph : `صيدلية ${ph}`) : 'طلبية';
  const out = [`${head}${d.areaName ? ` - ${d.areaName}` : ''}`];
  lines.forEach((l) => {
    const bonus = Number(l.bonus) > 0 ? ` + ${fmtQty(l.bonus)}` : '';
    out.push(`${l.item} ${fmtQty(l.quantity)}${bonus}`);
  });
  if (d.notes) out.push(String(d.notes).trim());
  return out.join('\n');
}

export function buildOrderText(d, { forGroup = false } = {}) {
  if (forGroup) return buildGroupOrderText(d);
  const lines = Array.isArray(d.lines) ? d.lines : [];
  const out = [`📦 طلبية جديدة رقم ${d.id}`];
  if (d.repName) out.push(`👤 المندوب: ${d.repName}`);
  out.push(`🏥 الصيدلية: ${d.pharmacyName || '—'}${d.areaName ? ` — ${d.areaName}` : ''}`);
  out.push('────────────');
  lines.forEach((l, i) => out.push(lineText(l, i)));
  out.push('────────────');
  if (d.notes) out.push(`📝 ${d.notes}`);
  out.push('اختاروا أحد الأزرار، أو أرسلوا صورة فاتورة التجهيز رداً على هذه الرسالة.');
  return out.join('\n');
}

const itemsSummary = (d) => (Array.isArray(d.lines) ? d.lines : []).map((l) =>
  `${l.item} ×${fmtQty(l.quantity)}${Number(l.bonus) > 0 ? `+${fmtQty(l.bonus)}` : ''}`).join('، ');

const actionPayload = (id, action) => `wd:${id}:${action}`;

// ─── الإرسال ─────────────────────────────────────────────────────────────────

async function originLabel(d) {
  if (d.repName) return d.repName;
  const u = await prisma.user.findUnique({ where: { id: d.createdById }, select: { displayName: true, username: true } });
  return u?.displayName || u?.username || '—';
}

async function sendViaTemplate(d, to) {
  return sendTemplate(to, templateName(), templateLang(),
    [String(d.id), await originLabel(d), `${d.pharmacyName || '—'}${d.areaName ? ` - ${d.areaName}` : ''}`, itemsSummary(d)],
    ['prepared', 'partial', 'rejected'].map(a => actionPayload(d.id, a)));
}

/** إرسال حرّ بأزرار. نصّ أطول من حدّ الرسالة التفاعلية يُرسَل كاملاً أولاً ثم الأزرار. */
async function sendViaButtons(d, to) {
  const text = buildOrderText(d);
  const buttons = ['prepared', 'partial', 'rejected'].map(a => ({ id: actionPayload(d.id, a), title: ACTION_LABEL[a] }));
  if (text.length <= 1000) {
    const r = await sendButtons(to, text, buttons);
    return r.id ? { ids: [r.id] } : r;
  }
  const t = await sendWhatsAppText(to, text);
  if (!t) return { error: { code: 'UNKNOWN', message: 'تعذّر إرسال نصّ الطلبية' } };
  const r = await sendButtons(to, `الطلبية رقم ${d.id} أعلاه — اختاروا:`, buttons);
  return r.id ? { ids: [t, r.id] } : r;
}

/**
 * يرسل صفّ dispatch لمذخره الحالي. يُعيد الصف المحدَّث. لا يرمي.
 * @param {{ byUserId?: number, forceTemplate?: boolean }} [o]
 */
export async function sendDispatch(dispatchOrId, { byUserId = null, forceTemplate = false } = {}) {
  const d = typeof dispatchOrId === 'object' ? dispatchOrId : await prisma.warehouseDispatch.findUnique({ where: { id: Number(dispatchOrId) } });
  if (!d) return null;
  const w = d.warehouseId ? await prisma.orderWarehouse.findUnique({ where: { id: d.warehouseId } }) : null;
  const fail = (msg, status = 'failed') => prisma.warehouseDispatch.update({ where: { id: d.id }, data: { status, error: msg } });

  if (!w) return fail('لم يُحدَّد مذخر من الدليل', 'needs_warehouse');
  if (!warehouseReady(w)) return fail(notReadyReason(w), 'needs_warehouse');

  // حارس سباق: ضغطتا «إرسال» متزامنتان لا ترسلان مرتين
  const claimed = await prisma.warehouseDispatch.updateMany({
    where: { id: d.id, status: { notIn: ['sending', 'cancelled'] } },
    data: { status: 'sending', error: null },
  });
  if (!claimed.count) return prisma.warehouseDispatch.findUnique({ where: { id: d.id } });

  let ids = [], kind, err = null;
  if (w.channel === 'group') {
    const r = await sendGroupText(w.groupJid, buildOrderText(d, { forGroup: true }));
    if (r.id) { ids = [r.id]; kind = 'group'; }
    else err = r.error;
  } else {
    if (!whatsappEnabled()) err = 'بوت واتساب غير مفعّل على السيرفر';
    else {
      const to = normalizeWaId(w.waId || w.phone);
      const windowOpen = w.waLastInboundAt && Date.now() - new Date(w.waLastInboundAt).getTime() < WINDOW_MS;
      let r;
      // محادثة هذا المذخر تحديداً (قد يشارك رقمه حساباً أو مذخراً آخر)
      await withParty(to, `wh:${w.id}`, async () => {
        if (windowOpen && !forceTemplate) {
          r = await sendViaButtons(d, to);
          if (r.ids) { ids = r.ids; kind = 'service'; }
          else if (r.error?.code === 131047) r = null; // النافذة أُغلقت فعلاً ⇒ قالب
        }
        if (!ids.length && !(r && r.error)) {
          r = await sendViaTemplate(d, to);
          if (r.id) { ids = [r.id]; kind = 'template'; }
        }
      });
      if (!ids.length) err = templateErrorText(r?.error);
    }
  }

  if (!ids.length) {
    const failed = await prisma.warehouseDispatch.update({ where: { id: d.id }, data: { status: 'failed', error: err || 'تعذّر الإرسال' } });
    console.error(`[dispatch] #${d.id} فشل الإرسال إلى ${w.name}:`, err);
    return failed;
  }
  const sent = await prisma.warehouseDispatch.update({
    where: { id: d.id },
    data: {
      status: 'sent', channel: w.channel === 'group' ? 'group' : 'cloud', sendKind: kind,
      outMessageIds: { push: ids }, sentAt: new Date(), sentById: byUserId, error: null,
      warehouseName: w.name, deliveredAt: null, readAt: null,
    },
  });
  await notifyOrigin(sent, `📤 الطلبية ${d.pharmacyName ? `(${d.pharmacyName}) ` : ''}أُرسلت لمذخر ${w.name} — رقم ${d.id}`);
  await markRepOrderSent(sent, w.id);
  return sent;
}

/**
 * طلبية من «طلبيات المذاخر» أُرسلت عبر البوت (أي مسار: فوري، موافقة المدير، تحويل،
 * بديل تلقائي) ⇒ سجل إرسال لهذا المذخر هناك، فتُربط به ردود المذخر وفاتورته.
 */
async function markRepOrderSent(d, warehouseId) {
  if (!d.repOrderId) return;
  try {
    const r = d.sentById ? await markSent({ id: d.sentById }, d.repOrderId, warehouseId) : { updated: 0 };
    // المُرسِل خارج نطاق الطلبية (أو إرسال آلي) ⇒ باسم صاحبها
    if (!r.updated) await markSent({ id: d.createdById }, d.repOrderId, warehouseId);
  } catch (e) {
    console.error('[dispatch] تعليم طلبية المذاخر مُرسلة:', e?.message);
  }
}

function templateErrorText(e) {
  if (!e) return 'تعذّر الإرسال';
  if (e.code === 132001) return `قالب «${templateName()}» غير موجود أو غير معتمد بعد في Meta`;
  if (e.code === 131026) return 'رقم المذخر غير مسجّل على واتساب';
  if (e.code === 131047) return 'خارج نافذة الـ24 ساعة';
  return `${e.code ? `[${e.code}] ` : ''}${e.message || 'تعذّر الإرسال'}`;
}

// ─── الإنشاء من طلبية البوت ──────────────────────────────────────────────────

const cleanStr = (v, n = 200) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; };

/** صفوف طلبية البوت ← مجموعات (صيدلية × مذخر مكتوب). */
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    if (!r?.item) continue;
    const k = `${whKey(r.pharmacy)}|${whKey(r.warehouse)}`;
    if (!groups.has(k)) groups.set(k, { pharmacy: cleanStr(r.pharmacy), area: cleanStr(r.area), warehouse: cleanStr(r.warehouse), lines: [] });
    groups.get(k).lines.push({ item: cleanStr(r.item, 160), quantity: Math.round(Number(r.quantity) || 0), bonus: Math.round(Number(r.bonus) || 0) });
  }
  return [...groups.values()];
}

/**
 * يُستدعى بعد تسجيل طلبية البوت (ingestBotOrder). best-effort — لا يرمي ولا يؤخّر
 * ردّ البوت (المستدعي لا ينتظره). إعادة قراءة نفس الطلبية تحدّث الصفوف غير المرسَلة.
 */
export async function createFromBotOrder({ user, pendingId, rows, source, chatId, repName }) {
  try {
    const mode = await getUserMode(user.id);
    if (mode === 'off') return;
    const owner = { id: user.id, role: user.role, officeId: user.officeId ?? null };
    // طلبية مسوّق المحافظة من البوت تنتظر موافقة مديره حتى لو حسابه على «فوري»
    const autoSend = mode === 'auto' && await canDispatchOrders(user);
    for (const g of groupRows(rows)) {
      const w = await matchWarehouse(g.warehouse, owner);
      const ready = warehouseReady(w);
      const status = ready ? 'awaiting_approval' : 'needs_warehouse';
      const data = {
        officeId: user.officeId ?? null, createdById: user.id, source: 'bot', pendingOrderId: pendingId ?? null,
        originTransport: source, originChatId: chatId != null ? String(chatId) : null, repName: cleanStr(repName),
        pharmacyName: g.pharmacy, areaName: g.area, requestedWarehouse: g.warehouse,
        warehouseId: w?.id ?? null, warehouseName: w?.name ?? g.warehouse, lines: g.lines,
      };
      // إعادة قراءة (🔄): نفس الطلبية المعلّقة ونفس الصيدلية/المذخر ⇒ تحديث لا تكرار
      const prev = pendingId ? await prisma.warehouseDispatch.findFirst({
        where: { pendingOrderId: pendingId, pharmacyName: g.pharmacy, requestedWarehouse: g.warehouse },
      }) : null;
      let d;
      if (prev) {
        if (!PRE_SEND.includes(prev.status)) continue; // أُرسلت — لا نمسّها
        d = await prisma.warehouseDispatch.update({ where: { id: prev.id }, data: { ...data, status } });
      } else {
        d = await prisma.warehouseDispatch.create({ data: { ...data, status } });
      }
      if (autoSend && ready) await sendDispatch(d);
      else if (!w && g.warehouse) await notifyOrigin(d, `⚠️ المذخر «${g.warehouse}» غير موجود في دليل المذاخر — الطلبية رقم ${d.id} بانتظار تحديد المذخر من التطبيق`);
    }
  } catch (e) {
    console.error('[dispatch] تعذّر إنشاء إرسال المذخر من طلبية البوت:', e);
  }
}

/**
 * طلبية كُتبت أو عُدّلت في «طلبيات المذاخر» ⇒ تتبع وضع حساب كاتبها: «فوري» تُرسل
 * لمذخرها الأساسي عبر البوت، «بعد الموافقة» تنتظر في صفحة الإرسال. مذخر غير مضبوط
 * للإرسال الآلي ⇒ لا شيء (المندوب يرسلها يدوياً كما كان). لا يرمي.
 * allowNew=false (خانة «إرسال عبر البوت» مطفأة) ⇒ لا صفّ جديد، تحديث القائم فقط.
 * @returns {Promise<object|null>} صفّ الإرسال إن أُنشئ أو حُدّث
 */
export async function createFromRepOrder(orderId, { allowNew = true } = {}) {
  try {
    const o = await prisma.repOrder.findUnique({ where: { id: Number(orderId) }, include: { lines: { orderBy: { id: 'asc' } } } });
    if (!o || o.status !== 'pending') return null;
    const lines = o.lines.map(l => ({ item: l.itemName, quantity: l.quantity, bonus: l.bonusQty }));
    // تعديل طلبية لم تُرسل بعد ⇒ تحديث صفّها بدل صفّ ثانٍ
    const prev = await prisma.warehouseDispatch.findFirst({ where: { repOrderId: o.id }, orderBy: { id: 'desc' } });
    if (prev) {
      if (!PRE_SEND.includes(prev.status)) return null;
      return prisma.warehouseDispatch.update({
        where: { id: prev.id },
        data: { lines, notes: o.notes, pharmacyName: o.pharmacyName, areaName: o.areaName },
      });
    }
    // أُرسلت يدوياً سابقاً (wa.me/مشاركة) ⇒ تعديلها لا يرسلها مرة ثانية
    if (o.sentAt || !allowNew) return null;
    const mode = await getUserMode(o.createdById);
    if (mode === 'off' || !o.warehouseId) return null;
    const w = await prisma.orderWarehouse.findUnique({ where: { id: o.warehouseId } });
    if (!warehouseReady(w)) return null;
    const creator = await prisma.user.findUnique({ where: { id: o.createdById }, select: { displayName: true, username: true } });
    const d = await prisma.warehouseDispatch.create({
      data: {
        officeId: o.officeId, createdById: o.createdById, source: 'rep-order', repOrderId: o.id,
        repName: creator?.displayName || creator?.username || null, pharmacyName: o.pharmacyName, areaName: o.areaName,
        requestedWarehouse: o.warehouseName, warehouseId: w.id, warehouseName: w.name,
        lines, notes: o.notes, status: 'awaiting_approval',
      },
    });
    return mode === 'auto' ? sendDispatch(d, { byUserId: o.createdById }) : d;
  } catch (e) {
    console.error('[dispatch] إرسال آلي لطلبية المذاخر:', e);
    return null;
  }
}

// ─── ردّ المذخر ──────────────────────────────────────────────────────────────

/** ردّ للمذخر على قناته (best-effort). */
export async function replyToWarehouse(d, text) {
  try {
    const w = d.warehouseId ? await prisma.orderWarehouse.findUnique({ where: { id: d.warehouseId } }) : null;
    if (!w) return;
    // كروب المذخر: لا إقرارات ولا «شكراً» — النظام يرسل الطلبيات فقط ويقرأ بصمت (طلب صاحب المشروع)
    if (d.channel === 'group') return;
    const to = normalizeWaId(w.waId || w.phone);
    await withParty(to, `wh:${w.id}`, () => sendWhatsAppText(to, text));
  } catch (e) {
    console.error('[dispatch] تعذّر الرد على المذخر:', e?.message);
  }
}

const STATUS_NOTE = {
  prepared: (d) => `✅ مذخر ${d.warehouseName} جهّز الطلبية رقم ${d.id}${d.pharmacyName ? ` (${d.pharmacyName})` : ''}`,
  partial:  (d) => `⚠️ مذخر ${d.warehouseName} جهّز الطلبية رقم ${d.id} جزئياً${d.pharmacyName ? ` (${d.pharmacyName})` : ''}`,
  rejected: (d) => `❌ مذخر ${d.warehouseName} رفض الطلبية رقم ${d.id}${d.rejectReason ? ` — السبب: ${d.rejectReason}` : ''}`,
};

/**
 * تطبيق ردّ المذخر. action: prepared | partial | rejected.
 * actor = اسم موظف المذخر الذي صوّت/ردّ في الكروب (يظهر في الإقرار وإشعار المندوب).
 * @param {{ reason?: string, via?: 'warehouse'|'manual', ack?: boolean, actor?: string }} [o]
 */
export async function applyAction(dispatchId, action, { reason = null, via = 'warehouse', ack = true, actor = null } = {}) {
  const d = await prisma.warehouseDispatch.findUnique({ where: { id: Number(dispatchId) } });
  if (!d || !ACTION_LABEL[action]) return null;
  if (d.status === 'cancelled') {
    if (via === 'warehouse' && ack) await replyToWarehouse(d, `الطلبية رقم ${d.id} أُلغيت من قبل المكتب — لا حاجة لتجهيزها.`);
    return d;
  }
  const updated = await prisma.warehouseDispatch.update({
    where: { id: d.id },
    data: {
      status: action, respondedAt: new Date(),
      ...(action === 'rejected' ? { rejectReason: cleanStr(reason, 300) } : {}),
      ...(actor ? { warehouseNote: [d.warehouseNote, `${ACTION_LABEL[action]} — ${cleanStr(actor, 80)}`].filter(Boolean).join('\n').slice(-1500) } : {}),
    },
  });
  const by = actor ? ` (${cleanStr(actor, 80)})` : '';
  if (via === 'warehouse' && ack) {
    const ackText = {
      prepared: `✅ شكراً — سُجّلت الطلبية رقم ${d.id} «تم التجهيز». أرسلوا صورة الفاتورة رداً على رسالة الطلبية إن أمكن.`,
      partial:  `⚠️ سُجّلت الطلبية رقم ${d.id} «تجهيز جزئي». أرسلوا صورة الفاتورة أو اكتبوا الأصناف الناقصة.`,
      rejected: reason ? `سُجّل رفض الطلبية رقم ${d.id}. شكراً.` : `سُجّل رفض الطلبية رقم ${d.id}. اكتبوا سبب الرفض باختصار رداً على رسالة الطلبية (اختياري).`,
    }[action];
    await replyToWarehouse(updated, ackText + by);
  }
  await notifyOrigin(updated, STATUS_NOTE[action](updated) + by);
  await syncRepOrder(updated);
  if (action === 'rejected') await maybeForwardToBackup(updated, 'rejected');
  return updated;
}

/** سبب الرفض يصل برسالة لاحقة. */
export async function setRejectReason(d, reason) {
  const updated = await prisma.warehouseDispatch.update({ where: { id: d.id }, data: { rejectReason: cleanStr(reason, 300) } });
  await replyToWarehouse(updated, `شكراً — سُجّل السبب للطلبية رقم ${d.id}.`);
  await notifyOrigin(updated, `📝 سبب رفض الطلبية رقم ${d.id} من ${d.warehouseName}: ${updated.rejectReason}`);
  return updated;
}

/** ملاحظة نصية حرّة من المذخر تُلحق بالطلبية. */
export async function appendWarehouseNote(d, text) {
  const note = cleanStr(text, 500);
  if (!note) return d;
  const merged = [d.warehouseNote, note].filter(Boolean).join('\n').slice(-1500);
  return prisma.warehouseDispatch.update({ where: { id: d.id }, data: { warehouseNote: merged, respondedAt: d.respondedAt || new Date() } });
}

/** حفظ صورة فاتورة المذخر على القرص ← المسار العام. */
export async function saveInvoiceImage(buffer) {
  await fs.promises.mkdir(DISPATCH_DIR, { recursive: true });
  // فاتورة PDF من نظام المذخر تُحفظ بامتدادها (الواجهة تعرضها رابطاً لا صورة)
  const name = `${crypto.randomBytes(16).toString('hex')}.${isPdf(buffer) ? 'pdf' : 'jpg'}`;
  await fs.promises.writeFile(path.join(DISPATCH_DIR, name), buffer);
  return `/uploads/dispatch/${name}`;
}

/** ربط صورة فاتورة (محفوظة مسبقاً) بطلبية ⇒ «تم التجهيز» إن لم تكن جزئية. */
/**
 * فاتورة مقروءة ← مقارنة بأسطر الطلبية. null = لا أسطر مقروءة (فشل القراءة) فيبقى السلوك القديم.
 * @returns {{ complete:boolean, matchedCount:number, summary:string } | null}
 */
export function invoiceVsOrder(d, rows) {
  const items = (Array.isArray(rows) ? rows : []).filter(r => r?.item);
  if (!items.length) return null;
  const orderLines = Array.isArray(d.lines) ? d.lines : [];
  const cmp = compareInvoiceLines(orderLines.map(l => ({ itemName: l.item, quantity: Number(l.quantity) || 0 })), items);
  const lines = orderLines.map((l, i) => ({ item: l.item, asked: Number(l.quantity) || 0, ...cmp[i] }));
  const short = lines.filter(l => l.qty < l.asked);
  const matchedCount = lines.filter(l => l.matched).length;
  const summary = !matchedCount
    ? '⚠️ لم تطابق أي مادة في الفاتورة مواد الطلبية — راجعوها.'
    : !short.length ? '✅ مجهّزة كاملة حسب الفاتورة.'
    : `⚠️ تجهيز ناقص:\n${short.map(l => `• ${l.item}: طُلب ${fmtQty(l.asked)}، جُهّز ${fmtQty(l.qty)}`).join('\n')}`;
  return { complete: matchedCount > 0 && !short.length, matchedCount, summary };
}

export async function attachInvoice(dispatchId, imagePath, { rows = null, ack = true } = {}) {
  const d = await prisma.warehouseDispatch.findUnique({ where: { id: Number(dispatchId) } });
  if (!d) return null;
  // الفاتورة مقروءة ⇒ هي التي تقرّر: كل المواد بكمياتها = مجهّزة، وإلا جزئية.
  // بلا قراءة (فشل الذكاء) ⇒ كما كان: مجهّزة (إلا إن كانت جزئية مسبقاً).
  const cmp = invoiceVsOrder(d, rows);
  const status = cmp ? (cmp.complete ? 'prepared' : 'partial') : (d.status === 'partial' ? 'partial' : 'prepared');
  const updated = await prisma.warehouseDispatch.update({
    where: { id: d.id },
    data: {
      invoiceImage: imagePath, ...(rows ? { invoiceRows: rows } : {}),
      status,
      respondedAt: new Date(),
    },
  });
  if (ack) await replyToWarehouse(updated, `🧾 استلمنا فاتورة الطلبية رقم ${d.id}. شكراً.`);
  await notifyOrigin(updated, `🧾 وصلت فاتورة تجهيز الطلبية رقم ${d.id} من مذخر ${d.warehouseName}${d.pharmacyName ? ` (${d.pharmacyName})` : ''}${cmp ? `\n${cmp.summary}` : ''}`);
  await syncRepOrder(updated, { rows: cmp?.matchedCount ? rows : null });
  return updated;
}

/**
 * طلبية من صفحة «طلبيات المذاخر» ⇒ تُسجَّل في سجل إرسالاتها (rep_order_sends) عبر
 * recordPreparation نفسه الذي تستعمله الصفحة: «تم» = كل المتبقي من هذا المذخر،
 * «رفض» = لا شيء. «جزئي» بلا أصناف معروفة ⇒ نعلّم السجل فقط ويكمل المندوب الكميات.
 */
async function syncRepOrder(d, { rows = null } = {}) {
  if (!d.repOrderId) return;
  try {
    const viewer = { id: d.sentById ?? null };
    if (rows) {
      // كميات الفاتورة الفعلية لكل سطر من طلبية المذاخر (الناقص يبقى للمذخر التالي)
      const order = await prisma.repOrder.findUnique({ where: { id: d.repOrderId }, include: { lines: { orderBy: { id: 'asc' } } } });
      if (order) {
        const cmp = compareInvoiceLines(order.lines, rows);
        await recordPreparation(viewer, d.repOrderId, {
          warehouseId: d.warehouseId,
          lines: order.lines.map((l, i) => ({ lineId: l.id, preparedQty: cmp[i].qty, preparedBonus: cmp[i].bonus })),
          image: d.invoiceImage || undefined,
          invoiceNumber: rows.find(r => r.invoiceNumber)?.invoiceNumber ?? null,
        });
        return;
      }
    }
    if (d.status === 'prepared') {
      await recordPreparation(viewer, d.repOrderId, { warehouseId: d.warehouseId, allRemaining: true, image: d.invoiceImage || undefined });
    } else if (d.status === 'rejected') {
      await recordPreparation(viewer, d.repOrderId, { warehouseId: d.warehouseId, lines: [] });
    } else if (d.status === 'partial') {
      const mark = () => prisma.repOrderSend.updateMany({
        where: { orderId: d.repOrderId, warehouseId: d.warehouseId, outcome: { in: ['sent', 'partial'] } },
        data: { outcome: 'partial', outcomeAt: new Date(), ...(d.invoiceImage ? { image: d.invoiceImage } : {}) },
      });
      // لا سجل إرسال لهذا المذخر بعد ⇒ يُنشأ ثم يُعلَّم، وإلا ضاعت الفاتورة
      if (!(await mark()).count) { await markRepOrderSent(d, d.warehouseId); await mark(); }
    }
  } catch (e) {
    console.error('[dispatch] مزامنة طلبية المذاخر:', e?.message);
  }
}

// ─── المذخر البديل ───────────────────────────────────────────────────────────

/** مذاخر جُرّبت في سلسلة هذا الإرسال (الأصل وكل البدائل). */
async function triedWarehouseIds(d) {
  const ids = new Set();
  let cur = d;
  for (let guard = 0; cur && guard < 20; guard++) {
    if (cur.warehouseId) ids.add(cur.warehouseId);
    cur = cur.parentId ? await prisma.warehouseDispatch.findUnique({ where: { id: cur.parentId } }) : null;
  }
  // الأبناء المنشأة سابقاً من هذا الصف
  const children = await prisma.warehouseDispatch.findMany({ where: { parentId: d.id }, select: { warehouseId: true } });
  children.forEach(c => c.warehouseId && ids.add(c.warehouseId));
  return ids;
}

/** يرسل نسخة للمذخر البديل التالي. يُعيد الصف الجديد أو null. */
export async function forwardToWarehouse(d, warehouseId, { byUserId = null } = {}) {
  const w = await prisma.orderWarehouse.findUnique({ where: { id: Number(warehouseId) } });
  if (!w) return null;
  const child = await prisma.warehouseDispatch.create({
    data: {
      officeId: d.officeId, createdById: d.createdById, source: d.source, pendingOrderId: d.pendingOrderId,
      repOrderId: d.repOrderId, originTransport: d.originTransport, originChatId: d.originChatId,
      repName: d.repName, pharmacyName: d.pharmacyName, areaName: d.areaName,
      requestedWarehouse: d.requestedWarehouse, warehouseId: w.id, warehouseName: w.name,
      lines: d.lines, notes: d.notes, status: 'awaiting_approval', attempt: (d.attempt || 1) + 1, parentId: d.id,
    },
  });
  return sendDispatch(child, { byUserId });
}

export async function maybeForwardToBackup(d, why) {
  try {
    const cfg = await getConfig();
    if (!cfg.autoBackup || !d.warehouseId) return null;
    const w = await prisma.orderWarehouse.findUnique({ where: { id: d.warehouseId } });
    const tried = await triedWarehouseIds(d);
    const nextId = (w?.backupWarehouseIds || []).find(id => !tried.has(id));
    if (!nextId) {
      if (why === 'no_response') await notifyOrigin(d, `⏰ لا ردّ من مذخر ${d.warehouseName} على الطلبية رقم ${d.id} — لا يوجد مذخر بديل مضبوط`);
      return null;
    }
    const child = await forwardToWarehouse(d, nextId);
    if (child) {
      await notifyOrigin(child, `↪️ الطلبية رقم ${d.id} حُوِّلت لمذخر ${child.warehouseName} (رقم ${child.id}) بسبب ${why === 'rejected' ? 'الرفض' : 'عدم الرد'}`);
    }
    return child;
  } catch (e) {
    console.error('[dispatch] تحويل للمذخر البديل:', e);
    return null;
  }
}

// ─── مهلة الرد ───────────────────────────────────────────────────────────────

let sweeping = false;
export async function sweepTimeouts() {
  if (sweeping) return;
  sweeping = true;
  try {
    const cfg = await getConfig();
    if (!(cfg.responseTimeoutMin > 0)) return; // المهلة معطّلة — الطلبية تنتظر ردّ المذخر بلا حدّ
    const cutoff = new Date(Date.now() - Math.max(10, cfg.responseTimeoutMin) * 60_000);
    const stale = await prisma.warehouseDispatch.findMany({
      where: { status: 'sent', respondedAt: null, sentAt: { lt: cutoff } },
      take: 50,
    });
    for (const d of stale) {
      const updated = await prisma.warehouseDispatch.update({ where: { id: d.id }, data: { status: 'no_response' } });
      const child = await maybeForwardToBackup(updated, 'no_response');
      if (!child && !cfg.autoBackup) await notifyOrigin(updated, `⏰ لا ردّ من مذخر ${d.warehouseName} على الطلبية رقم ${d.id} حتى الآن`);
    }
  } catch (e) {
    console.error('[dispatch] فحص المهلة:', e?.message);
  } finally {
    sweeping = false;
  }
}

let timer = null;
export function startDispatchTimers() {
  if (timer) return;
  timer = setInterval(sweepTimeouts, 5 * 60_000);
  timer.unref?.();
}
