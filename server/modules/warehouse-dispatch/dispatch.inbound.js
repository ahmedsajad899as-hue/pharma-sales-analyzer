// ════════════════════════════════════════════════════════════════════════════
// dispatch.inbound.js — ردود المذاخر الواردة: أزرار، نصّ («تم 12»، «رفض + السبب»)،
// وصورة فاتورة التجهيز. قناتان بمنطق واحد (handleWarehouseEvent):
//  • cloud — رقم البوت الرسمي (whatsapp.service يمرّر كل رسالة هنا أولاً).
//  • group — كروب عبر رقم الكروبات (wa-groups.routes يمرّر الرسائل الواردة).
//
// ربط الرد بالطلبية بالترتيب: حمولة الزر (wd:<id>:<action>) ← الرد على رسالة
// الطلبية (context/quoted id ∈ outMessageIds) ← رقم صريح في النص ← الطلبية
// المفتوحة الوحيدة لهذا المذخر (cloud فقط) ← وإلا نسأل «لأي طلبية؟».
//
// الكروب فيه كلام كثير لا يخصّنا: لا نتصرّف فيه إلا برد على رسالتنا أو رقم طلبية صريح،
// أو صوت على تصويت الطلبية (handleGroupPollVote — بديل الأزرار في الكروبات).
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { normalizeWaId } from '../../lib/waId.js';
import { extractInvoiceRows } from '../sales/sales.service.js';
import { scoreOrder } from '../rep-orders/rep-orders.invoice.js';
import { sendWhatsAppText, sendList, downloadMedia } from '../whatsapp/whatsapp.service.js';
import { sendGroupText } from '../wa-groups/wa-groups.client.js';
import {
  applyAction, attachInvoice, saveInvoiceImage, setRejectReason, appendWarehouseNote, sendDispatch, GROUP_POLL_ACTIONS,
} from './dispatch.core.js';

const OPEN_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const REASON_WINDOW_MS = 30 * 60 * 1000;
const AUTO_MIN_SCORE = 60;
const AUTO_MIN_GAP = 15;

// ─── تحليل نصّ المذخر ─────────────────────────────────────────────────────────

const toLatinDigits = (s) => String(s ?? '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660));
const ACTION_RES = [
  ['partial',  /^(?:تجهيز\s+جزئي|جزئي|جزئيه|جزئية|ناقص(?:ه|ة)?)(?=\s|$|\d|[.,،:-])/],
  ['rejected', /^(?:رفض|مرفوض(?:ه|ة)?|ماكو|غير\s+متوفر(?:ه|ة)?|لا\s+يوجد|نافذ(?:ه|ة)?|نفذ(?:ت)?|نعتذر|اعتذار|❌)(?=\s|$|\d|[.,،:-])/],
  ['prepared', /^(?:تم\s+التجهيز|تم|تمت|جاهز(?:ه|ة)?|مجهز(?:ه|ة)?|اتجهزت|تجهزت|✅)(?=\s|$|\d|[.,،:-])/],
];

/** «تم 12» / «رفض 12 المادة نافذة» / «جزئي» ⇒ { action, id, reason }. */
export function parseWarehouseText(raw) {
  const t = toLatinDigits(raw).replace(/\s+/g, ' ').trim();
  for (const [action, re] of ACTION_RES) {
    const m = t.match(re);
    if (!m) continue;
    let rest = t.slice(m[0].length).trim();
    const idm = rest.match(/^[#:\-.\s]*(\d{1,8})(?=\s|$|[.,،:-])/);
    let id = null;
    if (idm) { id = Number(idm[1]); rest = rest.slice(idm[0].length).trim(); }
    rest = rest.replace(/^[-–:,،.\s]+/, '').replace(/^(?:السبب|بسبب|لان|لأن)\s*[:\-]?\s*/, '').trim();
    return { action, id, reason: rest || null };
  }
  return { action: null, id: null, reason: null };
}

/** رقم طلبية صريح في نصّ حرّ (كابشن صورة): «#123» أو «طلبية 123» أو رقم وحيد. */
function explicitId(text) {
  const t = toLatinDigits(text);
  const m = t.match(/#\s*(\d{1,8})/) || t.match(/(?:طلبي[هة]|طلب|رقم)\s*[:\-]?\s*(\d{1,8})/) || t.trim().match(/^(\d{1,8})$/);
  return m ? Number(m[1]) : null;
}

// ─── مساعدات ─────────────────────────────────────────────────────────────────

async function dispatchFor(id, whIds) {
  if (!id) return null;
  const d = await prisma.warehouseDispatch.findUnique({ where: { id: Number(id) } });
  return d && whIds.includes(d.warehouseId) ? d : null;
}

async function dispatchByMessage(msgId, whIds) {
  if (!msgId) return null;
  const d = await prisma.warehouseDispatch.findFirst({ where: { outMessageIds: { has: String(msgId) } }, orderBy: { id: 'desc' } });
  return d && (!whIds || whIds.includes(d.warehouseId)) ? d : null;
}

/** طلبيات أُرسلت لهذا المذخر حديثاً وما زالت بلا فاتورة. */
function openDispatches(whIds, { needInvoice = false } = {}) {
  return prisma.warehouseDispatch.findMany({
    where: {
      warehouseId: { in: whIds },
      status: { in: needInvoice ? ['sent', 'no_response', 'prepared', 'partial'] : ['sent', 'no_response'] },
      sentAt: { gte: new Date(Date.now() - OPEN_LOOKBACK_MS) },
      ...(needInvoice ? { invoiceImage: null } : {}),
    },
    orderBy: { sentAt: 'desc' },
    take: 20,
  });
}

const shortLabel = (d) => `${d.id} - ${d.pharmacyName || 'بلا صيدلية'}`;

/** صورة فاتورة ← أقرب طلبية مفتوحة بالقراءة الذكية (صيدلية + أصناف + تاريخ). */
async function guessByInvoice(buffer, candidates) {
  let rows;
  try {
    rows = await extractInvoiceRows([{ mimeType: 'image/jpeg', base64: buffer.toString('base64') }]);
  } catch (e) {
    console.error('[dispatch] قراءة فاتورة المذخر:', e?.message);
    return { rows: null, best: null };
  }
  const head = rows.find(r => r.pharmacy) || rows[0] || {};
  const dm = String(rows.find(r => r.date)?.date || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const inv = {
    pharmacy: head.pharmacy || null,
    warehouse: rows.find(r => r.warehouse)?.warehouse || null,
    date: dm ? new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3], 12)) : null,
    items: rows.filter(r => r.item).map(r => ({ item: String(r.item), quantity: Math.round(Number(r.quantity) || 0), bonus: Math.round(Number(r.bonus) || 0) })),
  };
  const scored = candidates.map(d => ({
    d,
    score: scoreOrder({
      pharmacyName: d.pharmacyName, warehouseName: d.warehouseName, orderDate: d.sentAt || d.createdAt,
      lines: (Array.isArray(d.lines) ? d.lines : []).map(l => ({ itemName: l.item })),
    }, inv).score,
  })).sort((a, b) => b.score - a.score);
  const [a, b] = scored;
  const best = a && a.score >= AUTO_MIN_SCORE && (!b || a.score - b.score >= AUTO_MIN_GAP) ? a.d : null;
  return { rows: rows.map(r => ({ item: r.item, quantity: r.quantity, bonus: r.bonus, pharmacy: r.pharmacy, invoiceNumber: r.invoiceNumber })), best };
}

// صور قيد السؤال «لأي طلبية؟» في الكروب: معرّف رسالة الصورة/سؤالنا ← مسار الصورة
const pendingGroupImages = new Map(); // msgId → { imagePath, rows, at }
const PENDING_IMG_TTL = 24 * 60 * 60 * 1000;
function rememberGroupImage(ids, entry) {
  const now = Date.now();
  for (const [k, v] of pendingGroupImages) if (now - v.at > PENDING_IMG_TTL) pendingGroupImages.delete(k);
  ids.filter(Boolean).forEach(id => pendingGroupImages.set(String(id), { ...entry, at: now }));
}

// ─── المنطق المشترك ──────────────────────────────────────────────────────────

/**
 * @param {object} ctx  { channel:'cloud'|'group', whIds:number[], reply(text), askWhich(open, imageToken?) }
 * @param {object} ev   { payload, quotedId, text, hasImage, getImage(), msgId }
 * @returns {Promise<boolean>} true = استُهلكت الرسالة
 */
async function handleWarehouseEvent(ctx, ev) {
  const { whIds } = ctx;
  const quoted = ev.quotedId ? await dispatchByMessage(ev.quotedId, whIds) : null;

  // 1) أزرار
  if (ev.payload) {
    let m = ev.payload.match(/^wd:(\d+):(prepared|partial|rejected)$/);
    if (m) {
      const d = await dispatchFor(m[1], whIds);
      if (d) await applyAction(d.id, m[2]);
      return true;
    }
    m = ev.payload.match(/^wdi:(\d+):([a-f0-9]{32})$/);
    if (m) {
      const d = await dispatchFor(m[1], whIds);
      if (d) await attachInvoice(d.id, `/uploads/dispatch/${m[2]}.jpg`);
      return true;
    }
    return false;
  }

  // 2) صورة فاتورة
  if (ev.hasImage) {
    let target = quoted || await dispatchFor(explicitId(ev.text), whIds);
    // الكروب: صورة بلا رد على رسالتنا وبلا رقم طلبية = ليست لنا على الأغلب
    if (!target && ctx.channel === 'group') return false;
    const buffer = await ev.getImage();
    const imagePath = await saveInvoiceImage(buffer);
    let rows = null;
    if (!target) {
      const open = await openDispatches(whIds, { needInvoice: true });
      if (open.length === 1) target = open[0];
      else if (open.length > 1) {
        const g = await guessByInvoice(buffer, open);
        rows = g.rows;
        target = g.best;
        if (!target) {
          await ctx.askWhich(open, imagePath, ev.msgId, rows);
          return true;
        }
      } else {
        await ctx.reply('استلمنا الصورة، لكن لا توجد طلبية مفتوحة لديكم حالياً. إن كانت لطلبية معيّنة أرسلوها رداً على رسالة الطلبية.');
        return true;
      }
    }
    await attachInvoice(target.id, imagePath, { rows });
    return true;
  }

  // 3) نصّ
  const text = String(ev.text || '').trim();
  if (!text) return Boolean(quoted);

  // رقم طلبية رداً على سؤال «لأي طلبية؟» في الكروب
  if (ctx.channel === 'group' && ev.quotedId && pendingGroupImages.has(String(ev.quotedId))) {
    const d = await dispatchFor(explicitId(text), whIds);
    if (d) {
      const p = pendingGroupImages.get(String(ev.quotedId));
      pendingGroupImages.delete(String(ev.quotedId));
      await attachInvoice(d.id, p.imagePath, { rows: p.rows });
      return true;
    }
  }

  const parsed = parseWarehouseText(text);
  if (parsed.action) {
    let target = (await dispatchFor(parsed.id, whIds)) || quoted;
    if (!target && ctx.channel === 'cloud') {
      const open = await openDispatches(whIds);
      if (open.length === 1) target = open[0];
      else if (open.length > 1) {
        await ctx.reply(`لأي طلبية؟ اكتبوا الرقم مع الرد، مثلاً: «${text.split(/\s/)[0]} ${open[0].id}»\nالطلبيات المفتوحة:\n${open.slice(0, 10).map(shortLabel).join('\n')}`);
        return true;
      }
    }
    if (!target) return ctx.channel === 'cloud';
    await applyAction(target.id, parsed.action, { reason: parsed.reason });
    return true;
  }

  // سبب رفض بعد ضغط «رفض» مباشرة
  const recentReject = await prisma.warehouseDispatch.findFirst({
    where: { warehouseId: { in: whIds }, status: 'rejected', rejectReason: null, respondedAt: { gte: new Date(Date.now() - REASON_WINDOW_MS) } },
    orderBy: { respondedAt: 'desc' },
  });
  if (recentReject && (!quoted || quoted.id === recentReject.id) && (ctx.channel === 'cloud' || quoted)) {
    await setRejectReason(recentReject, text);
    return true;
  }

  if (quoted) { await appendWarehouseNote(quoted, text); return true; }
  if (ctx.channel === 'cloud') {
    const [latest] = await openDispatches(whIds, { needInvoice: true });
    if (latest) await appendWarehouseNote(latest, text);
    return true;
  }
  return false;
}

// ─── Cloud API ───────────────────────────────────────────────────────────────

/**
 * يُستدعى من whatsapp.service لكل رسالة واردة قبل مسار طلبيات المندوبين.
 * @returns {Promise<boolean>} true = رسالة مذخر عولجت هنا
 */
export async function handleWarehouseCloudMessage(message, _contactName, img) {
  const waId = normalizeWaId(message?.from);
  if (!waId) return false;
  const payload = message.type === 'button' ? message.button?.payload
    : message.type === 'interactive' ? (message.interactive?.button_reply?.id || message.interactive?.list_reply?.id)
    : null;
  const isOurPayload = /^wdi?:/.test(payload || '');
  const warehouses = await prisma.orderWarehouse.findMany({ where: { waId }, select: { id: true } });
  const quoted = message.context?.id ? await dispatchByMessage(message.context.id, null) : null;
  if (!warehouses.length && !isOurPayload && !quoted) return false;

  // رقم مربوط كمندوب أيضاً: رسائله العادية طلبيات، وردوده على رسائل المذخر ردود مذخر
  if (!isOurPayload && !quoted) {
    const link = await prisma.whatsAppChatLink.findUnique({ where: { waId } });
    if (link?.isActive) return false;
  }

  if (warehouses.length) {
    await prisma.orderWarehouse.updateMany({ where: { waId }, data: { waLastInboundAt: new Date() } });
  }
  const whIds = warehouses.map(w => w.id);
  if (quoted?.warehouseId && !whIds.includes(quoted.warehouseId)) {
    // الرد من رقم آخر للمذخر نفسه (موظف ثانٍ) — نقبله فقط لرسالة أُرسلت له فعلاً
    const w = await prisma.orderWarehouse.findUnique({ where: { id: quoted.warehouseId } });
    if (w && normalizeWaId(w.waId || w.phone) === waId) whIds.push(w.id);
  }
  if (!whIds.length) return false;

  const reply = (text) => sendWhatsAppText(waId, text);
  return handleWarehouseEvent({
    channel: 'cloud', whIds, reply,
    askWhich: async (open, imagePath) => {
      const token = imagePath.match(/([a-f0-9]{32})\.jpg$/)?.[1];
      const r = await sendList(waId, 'استلمنا صورة الفاتورة 🧾 — لأي طلبية هي؟', 'اختيار الطلبية',
        open.slice(0, 10).map(d => ({ id: `wdi:${d.id}:${token}`, title: `رقم ${d.id}`, description: d.pharmacyName || '' })));
      if (r.error) await reply(`استلمنا الصورة — لأي طلبية؟ أرسلوها مجدداً مع رقم الطلبية في التعليق.\n${open.slice(0, 10).map(shortLabel).join('\n')}`);
    },
  }, {
    payload: isOurPayload ? payload : null,
    quotedId: message.context?.id || null,
    text: img ? (img.caption || '') : (message.text?.body || ''),
    hasImage: Boolean(img),
    getImage: () => downloadMedia(img.id),
    msgId: message.id,
  });
}

/** أحداث تسليم رسائلنا (statuses). 131047 على رسالة حرّة ⇒ إعادة بقالب. */
export async function handleDispatchStatus(st) {
  if (!st?.id) return;
  const d = await dispatchByMessage(st.id, null);
  if (!d) return;
  if (st.status === 'delivered' && !d.deliveredAt) {
    await prisma.warehouseDispatch.update({ where: { id: d.id }, data: { deliveredAt: new Date() } });
  } else if (st.status === 'read' && !d.readAt) {
    await prisma.warehouseDispatch.update({ where: { id: d.id }, data: { readAt: new Date(), deliveredAt: d.deliveredAt || new Date() } });
  } else if (st.status === 'failed') {
    const err = st.errors?.[0];
    if (err?.code === 131047 && d.sendKind === 'service' && d.status === 'sent') {
      console.log(`[dispatch] #${d.id} النافذة مغلقة — إعادة الإرسال بقالب`);
      await sendDispatch(d.id, { forceTemplate: true });
      return;
    }
    if (['sent', 'sending'].includes(d.status)) {
      await prisma.warehouseDispatch.update({
        where: { id: d.id },
        data: { status: 'failed', error: `${err?.code ? `[${err.code}] ` : ''}${err?.error_data?.details || err?.title || err?.message || 'فشل التسليم'}` },
      });
    }
  }
}

// ─── كروبات (wa-groups) ──────────────────────────────────────────────────────

/**
 * صوت على تصويت طلبية (أُرسل مع نصّها، ومعرّفه ضمن outMessageIds). سحب الصوت
 * (option=null) أو تكرار نفس الحالة لا يغيّر شيئاً؛ تغيير الصوت يطبّق الحالة الجديدة.
 */
async function handleGroupPollVote(m, whIds) {
  const { pollId, option } = m.pollVote || {};
  const action = GROUP_POLL_ACTIONS[option];
  if (!action) return true;
  const d = await dispatchByMessage(pollId, whIds);
  if (!d || d.status === action) return true;
  await applyAction(d.id, action, { actor: m.senderName || (m.sender ? String(m.sender).split('@')[0] : null) });
  return true;
}

/**
 * رسالة واردة من كروب مذخر (عبر خدمة رقم الكروبات).
 * @param {{ jid, msgId, text, quotedId, imageBase64 }} m
 */
export async function handleGroupInbound(m) {
  if (!m?.jid) return false;
  const warehouses = await prisma.orderWarehouse.findMany({ where: { groupJid: String(m.jid), channel: 'group' }, select: { id: true } });
  if (!warehouses.length) return false;
  const whIds = warehouses.map(w => w.id);
  if (m.pollVote) return handleGroupPollVote(m, whIds);
  const reply = (text) => sendGroupText(m.jid, text, { quotedId: m.msgId });
  return handleWarehouseEvent({
    channel: 'group', whIds, reply,
    askWhich: async (open, imagePath, imageMsgId, rows) => {
      const r = await reply(`استلمنا صورة الفاتورة 🧾 — لأي طلبية هي؟ ردّوا على هذه الرسالة برقم الطلبية:\n${open.slice(0, 10).map(shortLabel).join('\n')}`);
      rememberGroupImage([imageMsgId, r?.id], { imagePath, rows });
    },
  }, {
    payload: null,
    quotedId: m.quotedId || null,
    text: m.text || '',
    hasImage: Boolean(m.imageBase64),
    getImage: async () => Buffer.from(m.imageBase64, 'base64'),
    msgId: m.msgId,
  });
}
