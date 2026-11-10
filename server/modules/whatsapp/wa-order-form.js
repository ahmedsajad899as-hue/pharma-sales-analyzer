// ════════════════════════════════════════════════════════════════════════════
// wa-order-form.js — نموذج الطلبية داخل واتساب (WhatsApp Flows) لرقم البوت الرسمي.
//
// المندوب يكتب اسم الصيدلية ← البوت يرد بزر «إدخال الطلبية» ← يُفتح نموذج داخل واتساب:
// الصيدلية (معبّأة)، النوع (مبيع تمّ / طلبية للمذخر)، المذخر، و10 أسطر (ايتم من قائمة
// ايتمات المندوب نفسه + العدد + البونص). الإرسال يعود للويب-هوك كرسالة nfm_reply.
//
// • النموذج «بلا endpoint»: كل البيانات المتغيّرة (الايتمات، المذاخر، الصيدلية) تُمرَّر
//   داخل رسالة النموذج نفسها (flow_action=navigate + data) — فلا تشفير ولا مفتاح RSA.
// • «مبيع تمّ» ← «مبيعات المندوبين» (غير مؤكد كأي مبيع بلا فاتورة) + طابور مراجعة ملف
//   اللكوديشن (بلا إرسال للمذخر). حساب اللكوديشن للمندوب يُسقط تكرار الاثنين (repLiquidation).
// • «طلبية للمذخر» ← «طلبيات المذاخر» ثم createFromRepOrder: إرسال فوري/بعد موافقة/لا إرسال
//   حسب وضع حساب المندوب في «إرسال للمذاخر» → الإعدادات.
// • لا ذكاء اصطناعي في أي خطوة — صفر توكنات.
// ════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma.js';
import { userFeatureOn } from '../../lib/userFeatures.js';
import { matchInvoiceCustomers } from '../../lib/invoiceCustomerMatch.js';
import { buildLines, cleanText, parseDay, createOrder, listWarehouses } from '../rep-orders/rep-orders.service.js';
import { createFromRepOrder } from '../warehouse-dispatch/dispatch.core.js';
import { ingestBotOrder } from '../orders/orders.service.js';
import { BOT_TO_CONDITION } from '../orders/bot-order-flow.js';

export const ORDER_FORM_FEATURE = 'wa_order_form';
export const FORM_LINES = 10;
const SCREEN = 'ORDER';
const MAX_ITEMS = 200;      // حدّ واتساب لخيارات القائمة المنسدلة
const TITLE_MAX = 30;       // حدّ طول عنوان الخيار
const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ─── الإعداد ─────────────────────────────────────────────────────────────────

let cfgCache = null;
let cfgAt = 0;
export async function getOrderFormConfig({ fresh = false } = {}) {
  if (!fresh && cfgCache && Date.now() - cfgAt < 60_000) return cfgCache;
  const row = await prisma.waBotConfig.findUnique({ where: { id: 1 } }).catch(() => null);
  cfgCache = { orderFlowId: row?.orderFlowId || process.env.WHATSAPP_ORDER_FLOW_ID || null, orderFlowDraft: Boolean(row?.orderFlowDraft) };
  cfgAt = Date.now();
  return cfgCache;
}

export async function setOrderFormConfig({ orderFlowId, orderFlowDraft }) {
  const data = {
    orderFlowId: cleanText(orderFlowId, 40)?.replace(/\D/g, '') || null,
    orderFlowDraft: Boolean(orderFlowDraft),
  };
  await prisma.waBotConfig.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  cfgCache = null;
  return getOrderFormConfig({ fresh: true });
}

// ─── JSON النموذج (يُلصق مرة واحدة في WhatsApp Manager) ─────────────────────

const optionList = (example) => ({
  type: 'array',
  items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
  __example__: example,
});

export function buildOrderFlowJson() {
  const lines = [];
  const payload = { pharmacy: '${form.pharmacy}', kind: '${form.kind}', warehouse: '${form.warehouse}' };
  for (let i = 1; i <= FORM_LINES; i++) {
    lines.push(
      { type: 'Dropdown', name: `item${i}`, label: `الايتم ${i}`, required: i === 1, 'data-source': '${data.items}' },
      { type: 'TextInput', name: `qty${i}`, label: `العدد ${i}`, 'input-type': 'number', required: i === 1 },
      { type: 'TextInput', name: `bonus${i}`, label: `البونص ${i}`, 'input-type': 'number', required: false },
    );
    payload[`item${i}`] = `\${form.item${i}}`;
    payload[`qty${i}`] = `\${form.qty${i}}`;
    payload[`bonus${i}`] = `\${form.bonus${i}}`;
  }
  return {
    version: '6.0',
    screens: [{
      id: SCREEN,
      title: 'إدخال طلبية',
      terminal: true,
      success: true,
      data: {
        pharmacy: { type: 'string', __example__: 'صيدلية النور' },
        note: { type: 'string', __example__: 'اختر الايتم واكتب العدد' },
        warehouses: optionList([{ id: 'none', title: 'بلا مذخر' }]),
        items: optionList([{ id: '1', title: 'Panadol 500mg' }]),
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextBody', text: '${data.note}' },
          { type: 'TextInput', name: 'pharmacy', label: 'الصيدلية', 'input-type': 'text', required: true, 'init-value': '${data.pharmacy}' },
          {
            type: 'RadioButtonsGroup', name: 'kind', label: 'النوع', required: true, 'init-value': 'sale',
            'data-source': [{ id: 'sale', title: 'مبيع تمّ' }, { id: 'order', title: 'طلبية للمذخر' }],
          },
          { type: 'Dropdown', name: 'warehouse', label: 'المذخر', required: false, 'data-source': '${data.warehouses}' },
          { type: 'TextSubheading', text: 'الأصناف' },
          ...lines,
          { type: 'Footer', label: 'إرسال', 'on-click-action': { name: 'complete', payload } },
        ],
      },
    }],
  };
}

// ─── بيانات المندوب ──────────────────────────────────────────────────────────

/**
 * ايتمات المندوب = نفس ما يراه في التطبيق (GET /api/items بهويته). منطق /api/items في
 * index.js طويل ومتشعّب (شركات + قائمة بيضاء + ملفات مشتركة)، فنسأله بدل نسخه كي لا
 * تختلف القائمتان أبداً.
 */
async function itemsForUser(user) {
  const secret = process.env.JWT_SECRET || 'pharma-sales-secret-key-2026';
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, secret, { expiresIn: '2m' });
  const res = await fetch(`http://127.0.0.1:${process.env.PORT || 8080}/api/items`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => null);
  const list = Array.isArray(j?.data) ? j.data : [];
  return list.filter(i => i?.id && i?.name);
}

async function warehousesForUser(user) {
  try {
    const { warehouses } = await listWarehouses({ id: user.id });
    return warehouses || [];
  } catch {
    return [];
  }
}

// ─── متى يُرسل النموذج ───────────────────────────────────────────────────────

// كلمة افتتاح صريحة (وحدها أو قبل اسم الصيدلية): «طلبية»، «مبيعي صيدلية النور»، «نموذج»
const OPEN_WORD_RE = /^(?:نموذج|فورم|form|طلبيه|طلبية|طلب|مبيعي|مبيعاتي|مبيع)(?=s|$)[s:،,-]*/i;
const PHARMACY_WORD_RE = /صيدل[يه]/;

/** اسم صيدلية فقط: سطر واحد قصير بلا أرقام. أي شيء فيه أرقام يبقى طلبية مكتوبة كالمعتاد. */
export function looksLikePharmacyName(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 60 || /[\r\n]/.test(t)) return false;
  if (/[0-9٠-٩]/.test(t)) return false;
  if (t.split(/\s+/).length > 6) return false;
  return /[؀-ۿA-Za-z]{2,}/.test(t);
}

export async function orderFormEnabledFor(user) {
  if (!userFeatureOn(user, ORDER_FORM_FEATURE, { optIn: true })) return false;
  return Boolean((await getOrderFormConfig()).orderFlowId);
}

/**
 * يرسل النموذج إن كانت الرسالة اسم صيدلية (أو «نموذج»). يُعيد true إن أُرسل.
 * @param {{ waId: string, user: object, text: string, sendRaw: Function }} p
 */
export async function maybeSendOrderForm({ waId, user, text, sendRaw, sendText }) {
  const t = String(text ?? '').trim();
  if (!looksLikePharmacyName(t)) return false; // فيه أرقام أو أسطر ⇒ طلبية مكتوبة كالمعتاد
  const opener = OPEN_WORD_RE.test(t);
  const rest = t.replace(OPEN_WORD_RE, '').trim();
  if (!(await orderFormEnabledFor(user))) return false;

  let pharmacy = rest;
  let area = null;
  let matched = false;
  if (pharmacy) {
    const rows = [{ pharmacy }];
    await matchInvoiceCustomers(rows).catch(() => {});
    matched = Boolean(rows[0]._pharmacyMatched);
    if (matched) pharmacy = rows[0].pharmacy;
    area = rows[0].area || null;
  }
  // دردشة عادية («شكراً»، «السلام عليكم») لا تفتح نموذجاً: يلزم كلمة افتتاح، أو كلمة
  // «صيدلية»، أو اسم يطابق صيدلية في الماستر
  if (!opener && !matched && !PHARMACY_WORD_RE.test(t)) return false;

  const cfg = await getOrderFormConfig();
  const [items, whs] = await Promise.all([itemsForUser(user), warehousesForUser(user)]);
  if (!items.length) {
    await sendText(waId, '⚠️ لا توجد ايتمات مرتبطة بحسابك لعرضها في النموذج — راجع مديرك.');
    return true;
  }

  const token = `wf_${crypto.randomBytes(12).toString('hex')}`;
  await prisma.waFlowSession.create({ data: { token, userId: user.id, waId: String(waId), pharmacy: pharmacy || null, area } });
  prisma.waFlowSession.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - SESSION_TTL_MS) }, submittedAt: null } }).catch(() => {});

  const shownItems = items.slice(0, MAX_ITEMS).map(i => ({ id: String(i.id), title: clip(i.name, TITLE_MAX) || `#${i.id}` }));
  const shownWh = [{ id: 'none', title: 'بلا مذخر' }, ...whs.slice(0, MAX_ITEMS - 1).map(w => ({ id: String(w.id), title: clip(w.name, TITLE_MAX) }))];
  const note = items.length > MAX_ITEMS
    ? `اختر الايتم واكتب العدد. تظهر أول ${MAX_ITEMS} ايتم من ${items.length}.`
    : 'اختر الايتم واكتب العدد — الأسطر الفارغة تُهمَل.';

  const body = pharmacy
    ? `🏥 ${pharmacy}${area ? ` — ${area}` : ''}\nاضغط الزر لإدخال الأصناف والأعداد.`
    : 'اضغط الزر لإدخال الطلبية (الصيدلية والأصناف والأعداد).';
  const r = await sendRaw(waId, {
    type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: body },
      footer: { text: 'مبيع تمّ أو طلبية للمذخر' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: token,
          flow_id: cfg.orderFlowId,
          flow_cta: 'إدخال الطلبية',
          flow_action: 'navigate',
          flow_action_payload: { screen: SCREEN, data: { pharmacy: pharmacy || '', note, warehouses: shownWh, items: shownItems } },
          ...(cfg.orderFlowDraft ? { mode: 'draft' } : {}),
        },
      },
    },
  });
  if (r.error) {
    console.error('[wa-form] تعذّر إرسال النموذج:', r.error.message);
    return false; // يكمل المسار العادي — لا نُسكت المندوب بسبب عطل في النموذج
  }
  return true;
}

// ─── استقبال النموذج المُرسَل ────────────────────────────────────────────────

/** nfm_reply ⇒ { token, pharmacy, kind, warehouseId, lines:[{itemId, quantity, bonusQty}] } */
export function parseFormResponse(responseJson) {
  let d = responseJson;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return null; } }
  if (!d || typeof d !== 'object') return null;
  const int = (v) => { const n = Math.floor(Number(String(v ?? '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660)))); return Number.isFinite(n) && n > 0 ? n : 0; };
  const lines = [];
  for (let i = 1; i <= FORM_LINES; i++) {
    const itemId = Number(d[`item${i}`]);
    const quantity = int(d[`qty${i}`]);
    if (!itemId || !quantity) continue;
    lines.push({ itemId, quantity, bonusQty: int(d[`bonus${i}`]) });
  }
  const wh = String(d.warehouse ?? '');
  return {
    token: String(d.flow_token ?? ''),
    pharmacy: cleanText(d.pharmacy, 160),
    kind: d.kind === 'order' ? 'order' : 'sale',
    warehouseId: /^\d+$/.test(wh) ? Number(wh) : null,
    lines,
  };
}

/** وصف مقروء لسجلّ المحادثات. */
export function describeFormReply(responseJson) {
  const f = parseFormResponse(responseJson);
  if (!f) return '📝 نموذج مُرسَل';
  return `📝 نموذج ${f.kind === 'order' ? 'طلبية للمذخر' : 'مبيع تمّ'} — ${f.pharmacy || 'بلا صيدلية'} · ${f.lines.length} صنف`;
}

const linesText = (lines) => lines.map(l => `• ${l.itemName}: ${l.quantity}${l.bonusQty ? ` + ${l.bonusQty} بونص` : ''}`).join('\n');

/**
 * يعالج إرسال النموذج. يُعيد true إن كانت الرسالة ردّ نموذج (عولجت أو رُفضت برسالة).
 * @param {{ message: object, waId: string, user: object|null, sendText: Function }} p
 */
export async function handleOrderFormReply({ message, waId, user, sendText }) {
  const nfm = message?.type === 'interactive' && message.interactive?.type === 'nfm_reply' ? message.interactive.nfm_reply : null;
  if (!nfm) return false;
  const f = parseFormResponse(nfm.response_json);
  if (!f) { await sendText(waId, '⚠️ تعذّر قراءة النموذج — أعد المحاولة.'); return true; }

  const session = f.token ? await prisma.waFlowSession.findUnique({ where: { token: f.token } }) : null;
  if (!session || session.waId !== String(waId)) {
    await sendText(waId, '⚠️ انتهت صلاحية هذا النموذج — اكتب اسم الصيدلية من جديد لفتح نموذج جديد.');
    return true;
  }
  if (session.submittedAt) {
    await sendText(waId, '🔁 هذا النموذج أُرسل مسبقاً ولم يُكرَّر. لطلبية جديدة اكتب اسم الصيدلية.');
    return true;
  }
  if (!user || user.id !== session.userId) {
    await sendText(waId, '⚠️ الحساب المرتبط بهذا الرقم تغيّر — اكتب اسم الصيدلية من جديد.');
    return true;
  }
  if (!f.pharmacy) { await sendText(waId, '⚠️ اسم الصيدلية فارغ — لم يُسجَّل شيء.'); return true; }

  // قفل الجلسة قبل الحفظ: ضغطتان متتاليتان على «إرسال» لا تُسجّلان مرتين
  const locked = await prisma.waFlowSession.updateMany({ where: { token: session.token, submittedAt: null }, data: { submittedAt: new Date() } });
  if (!locked.count) return true;

  try {
    const lines = await buildLines(f.lines);
    if (!lines.length) {
      await prisma.waFlowSession.update({ where: { token: session.token }, data: { submittedAt: null } });
      await sendText(waId, '⚠️ لم تختر أي ايتم مع عدده — املأ سطراً واحداً على الأقل وأرسل النموذج مرة ثانية.');
      return true;
    }

    // الصيدلية المكتوبة في النموذج قد تختلف عمّا أُرسل أولاً ⇒ مطابقة ثانية مع الماستر
    let pharmacy = f.pharmacy;
    let area = pharmacy === session.pharmacy ? session.area : null;
    if (pharmacy !== session.pharmacy) {
      const rows = [{ pharmacy }];
      await matchInvoiceCustomers(rows).catch(() => {});
      if (rows[0]._pharmacyMatched) pharmacy = rows[0].pharmacy;
      area = rows[0].area || null;
    }

    let warehouse = null;
    if (f.warehouseId) {
      const { warehouses } = await listWarehouses({ id: user.id });
      warehouse = (warehouses || []).find(w => w.id === f.warehouseId) || null;
    }
    const repName = user.displayName || user.username;

    if (f.kind === 'order') {
      if (!warehouse) {
        await prisma.waFlowSession.update({ where: { token: session.token }, data: { submittedAt: null } });
        await sendText(waId, '⚠️ الطلبية للمذخر تحتاج اختيار المذخر — افتح النموذج من جديد واختره.');
        return true;
      }
      const order = await createOrder({ id: user.id }, {
        pharmacyName: pharmacy, areaName: area, warehouseId: warehouse.id,
        notes: 'من نموذج واتساب',
        lines: lines.map(l => ({ itemId: l.itemId, itemName: l.itemName, quantity: l.quantity, bonusQty: l.bonusQty })),
      });
      const d = await createFromRepOrder(order.id);
      await prisma.waFlowSession.update({ where: { token: session.token }, data: { result: `order:${order.id}` } });
      const state = !d ? 'سُجّلت في «طلبيات المذاخر» (الإرسال للمذخر من التطبيق)'
        : d.status === 'sent' ? `📤 أُرسلت للمذخر ${d.warehouseName}`
          : d.status === 'awaiting_approval' ? '⏳ بانتظار موافقة المدير قبل إرسالها للمذخر'
            : d.status === 'failed' ? `⚠️ تعذّر إرسالها للمذخر — ستظهر للمدير (${d.error || 'خطأ'})`
              : 'سُجّلت وستُرسل للمذخر';
      await sendText(waId, `✅ طلبية #${order.id} — ${pharmacy} ← ${warehouse.name}\n${linesText(lines)}\n${state}`);
      return true;
    }

    // ── مبيع تمّ ──
    const sale = await prisma.repSale.create({
      data: {
        officeId: user.officeId ?? null,
        createdById: user.id,
        saleDate: parseDay(null),
        pharmacyName: cleanText(pharmacy, 160),
        areaName: cleanText(area, 120),
        warehouseName: cleanText(warehouse?.name, 120),
        notes: 'من نموذج واتساب',
        status: 'pending',
        sourceHash: crypto.createHash('sha256').update(`wa-form|${session.token}`).digest('hex'),
        lines: { create: lines },
      },
    });
    await prisma.waFlowSession.update({ where: { token: session.token }, data: { result: `sale:${sale.id}` } });

    let condNote = '';
    if (userFeatureOn(user, BOT_TO_CONDITION)) {
      try {
        const rows = lines.map(l => ({
          item: l.itemName, quantity: l.quantity, bonus: l.bonusQty || 0,
          pharmacy, area, warehouse: warehouse?.name || null, company: l.companyName,
          unitPrice: l.unitPrice, _itemId: l.itemId, scientificRep: repName, _repSource: 'sender',
        }));
        const msg = await ingestBotOrder({
          user, source: 'whatsapp', chatId: String(waId), chatTitle: repName, senderName: repName,
          kind: 'form', sourceText: `نموذج واتساب: ${pharmacy}\n${linesText(lines)}`, rows,
          readBy: 'form', dispatch: false,
        });
        condNote = `\n📥 ملف اللكوديشن: ${msg.split('\n')[0]} (بانتظار المراجعة)`;
      } catch (e) {
        condNote = `\n⚠️ لم يدخل طابور ملف اللكوديشن: ${e?.isOperational ? e.message : 'خطأ'}`;
        console.error('[wa-form] ملف اللكوديشن:', e?.message);
      }
    }
    await sendText(waId,
      `✅ مبيع — ${pharmacy}${warehouse ? ` (${warehouse.name})` : ''}\n${linesText(lines)}\n`
      + '💵 سُجّل في «مبيعات المندوبين» غير مؤكد — يتأكد بصورة الفاتورة أو بعد 24 ساعة من التطبيق.'
      + condNote);
    return true;
  } catch (err) {
    console.error('[wa-form] فشل حفظ النموذج:', err);
    await prisma.waFlowSession.update({ where: { token: session.token }, data: { submittedAt: null } }).catch(() => {});
    await sendText(waId, `⚠️ ${err?.isOperational ? err.message : 'تعذّر حفظ النموذج — أعد إرساله.'}`);
    return true;
  }
}
