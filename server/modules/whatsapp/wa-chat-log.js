// ════════════════════════════════════════════════════════════════════════════
// wa-chat-log.js — سجلّ محادثات رقم البوت الرسمي: كل رسالة واردة (من مندوب أو مذخر
// أو رقم غير مربوط) وكل رسالة صادرة من البوت. الغاية أن يرى المدير ومالك التطبيق
// ما يدور فعلاً في المحادثات (تبويب «المحادثات» في «إرسال للمذاخر»).
//
// best-effort: فشل التسجيل لا يمسّ الاستقبال ولا الإرسال أبداً.
// ════════════════════════════════════════════════════════════════════════════

import { AsyncLocalStorage } from 'node:async_hooks';
import prisma from '../../lib/prisma.js';
import { describeFormReply } from './wa-order-form.js';

const KEEP_DAYS = 90;
const MAX_TEXT = 4000;
let sincePrune = 0;

const clip = (s) => {
  const t = String(s ?? '').trim();
  return t ? t.slice(0, MAX_TEXT) : null;
};

async function prune() {
  try {
    await prisma.waMessageLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * 86_400_000) } } });
  } catch (e) { console.error('[wa-log] prune:', e?.message); }
}

// ─── صاحب المحادثة (party) ────────────────────────────────────────────────────
// رقم واتساب واحد قد يكون مذخراً وحساباً مربوطاً وزبون حملة معاً. كل رسالة تُوسَم
// بالجهة التي تخصّها كي تظهر لكل جهة محادثتها الخاصة ولا تختلط:
//   wh:<id مذخر> | acct:<id حساب> | c:<اسم زبون الحملة> | null = رقم غير معروف.
// أثناء معالجة رسالة واردة تُحفظ الجهة في سياق async فتُوسَم ردود البوت عليها تلقائياً
// — فقط لرسائل نفس الرقم (إشعار لرقم آخر خلال المعالجة لا يرث الوسم).
const partyStore = new AsyncLocalStorage();

/** شغّل fn وكل رسالة تُرسل خلالها إلى waId توسَم بـparty. */
export function withParty(waId, party, fn) {
  return partyStore.run({ waId: String(waId), party: party ?? null }, fn);
}

export const campaignParty = (name) => `c:${String(name ?? '').trim().slice(0, 80)}`;

/** الجهة الافتراضية لرقم — بنفس ترتيب توجيه البوت: حساب مربوط ← مذخر ← زبون حملة. */
export async function defaultParty(waId) {
  const id = String(waId ?? '');
  if (!id) return null;
  try {
    const link = await prisma.whatsAppChatLink.findUnique({ where: { waId: id }, select: { userId: true, isActive: true } });
    if (link?.isActive) return `acct:${link.userId}`;
    const whs = await prisma.orderWarehouse.findMany({ where: { waId: id }, select: { id: true }, orderBy: { id: 'asc' } });
    if (whs.length === 1) return `wh:${whs[0].id}`;
    if (whs.length > 1) {
      // أكثر من مذخر بنفس الرقم: آخر مذخر راسله البوت
      const last = await prisma.waMessageLog.findFirst({ where: { waId: id, direction: 'out', party: { in: whs.map(w => `wh:${w.id}`) } }, orderBy: { id: 'desc' }, select: { party: true } });
      return last?.party || `wh:${whs[0].id}`;
    }
    const r = await prisma.waCampaignRecipient.findFirst({
      where: { waId: id, sentAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, orderBy: { sentAt: 'desc' }, select: { name: true },
    });
    if (r) return campaignParty(r.name);
    if (link) return `acct:${link.userId}`; // ربط معطّل
  } catch (e) { console.error('[wa-log] defaultParty:', e?.message); }
  return null;
}

/** جهة رسالة واردة: زر حملة ← ردّ على رسالة موسومة ← الافتراضي. */
export async function inboundParty(message) {
  try {
    const payload = String(message?.button?.payload || '');
    const m = payload.match(/^wc:(\d+):/);
    if (m) {
      const r = await prisma.waCampaignRecipient.findUnique({ where: { id: Number(m[1]) }, select: { name: true } });
      if (r) return campaignParty(r.name);
    }
    if (message?.context?.id) {
      const q = await prisma.waMessageLog.findFirst({ where: { waMessageId: String(message.context.id) }, select: { party: true } });
      if (q?.party) return q.party;
    }
  } catch (e) { console.error('[wa-log] inboundParty:', e?.message); }
  return defaultParty(message?.from);
}

async function resolveParty(row) {
  if (row.party !== undefined) return row.party;
  const st = partyStore.getStore();
  if (st && st.waId === String(row.waId)) return st.party;
  return defaultParty(row.waId);
}

export async function logWa(row) {
  try {
    const party = await resolveParty(row);
    await prisma.waMessageLog.create({
      data: {
        party,
        waId: String(row.waId ?? ''),
        direction: row.direction,
        kind: row.kind || 'other',
        text: clip(row.text),
        mediaId: row.mediaId ? String(row.mediaId) : null,
        contactName: row.contactName ? String(row.contactName).slice(0, 120) : null,
        waMessageId: row.waMessageId ? String(row.waMessageId) : null,
        error: row.error ? String(row.error).slice(0, 500) : null,
        sentById: row.sentById ?? null,
        sentByName: row.sentByName ? String(row.sentByName).slice(0, 120) : null,
      },
    });
    if (++sincePrune >= 500) { sincePrune = 0; prune(); }
  } catch (e) {
    console.error('[wa-log] تعذّر تسجيل الرسالة:', e?.message);
  }
}

/**
 * مرة عند الإقلاع: رسائل ما قبل وسم الجهة (party = null) تُنسب لصاحبها.
 * قوالب الحملات بمعرّف الرسالة، وأزرار الحملة وردود البوت عليها بالتوقيت، والباقي للجهة الافتراضية.
 */
export async function backfillParties() {
  try {
    const nulls = await prisma.waMessageLog.groupBy({ by: ['waId'], where: { party: null } });
    if (!nulls.length) return;
    let n = 0;
    const recips = await prisma.waCampaignRecipient.findMany({
      where: { waId: { in: nulls.map(g => g.waId) }, waMessageId: { not: null } }, select: { waId: true, name: true, waMessageId: true, sentAt: true },
    });
    const DISPATCH_BTNS = new Set(['🔘 تم التجهيز', '🔘 تجهيز جزئي', '🔘 رفض']);
    for (const r of recips) {
      const party = campaignParty(r.name);
      n += (await prisma.waMessageLog.updateMany({ where: { waMessageId: r.waMessageId, party: null }, data: { party } })).count;
      if (!r.sentAt) continue;
      // أزرار القالب التي ضغطها الزبون خلال 30 يوماً + ردّ البوت الآلي خلال دقيقتين منها
      const presses = await prisma.waMessageLog.findMany({
        where: { waId: r.waId, party: null, direction: 'in', kind: 'button', createdAt: { gte: r.sentAt, lte: new Date(r.sentAt.getTime() + 30 * 86_400_000) } },
        select: { id: true, text: true, createdAt: true },
      });
      for (const p of presses) {
        if (DISPATCH_BTNS.has(String(p.text || '').trim())) continue;
        n += (await prisma.waMessageLog.updateMany({
          where: { OR: [{ id: p.id }, { waId: r.waId, party: null, direction: 'out', sentById: null, createdAt: { gte: p.createdAt, lte: new Date(p.createdAt.getTime() + 120_000) } }] },
          data: { party },
        })).count;
      }
    }
    for (const g of nulls) {
      const party = await defaultParty(g.waId);
      if (party) n += (await prisma.waMessageLog.updateMany({ where: { waId: g.waId, party: null }, data: { party } })).count;
    }
    if (n) console.log(`[wa-log] نُسبت ${n} رسالة قديمة لأصحابها`);
  } catch (e) { console.error('[wa-log] backfillParties:', e?.message); }
}

// بعد ردّ يدوي من إنسان تصبح المحادثة «بشرية» لهذه المدة: كلام الطرف الآخر العادي
// لا يُقرأ كطلبية ولا يردّ عليه البوت (ولا يصرف توكنات) — الأزرار والصور و«تم/رفض»
// وكلمة «طلبية» الصريحة تبقى تعمل.
export const HUMAN_WINDOW_MS = 30 * 60 * 1000;

/** هل الرسالة ردّ على رسالة كتبها إنسان، أو جاءت خلال نافذة محادثة بشرية؟ */
export async function humanChatState(waId, contextId) {
  try {
    const [quoted, lastHuman] = await Promise.all([
      contextId ? prisma.waMessageLog.findFirst({ where: { waMessageId: String(contextId) }, select: { sentById: true, kind: true } }) : null,
      // قالب الحملة يحمل منشئها (sentById) لكنه ليس محادثة بشرية — لا يُسكت البوت
      prisma.waMessageLog.findFirst({
        where: { waId: String(waId), direction: 'out', sentById: { not: null }, kind: { not: 'template' }, error: null, createdAt: { gte: new Date(Date.now() - HUMAN_WINDOW_MS) } },
        select: { id: true },
      }),
    ]);
    return { replyToHuman: Boolean(quoted?.sentById && quoted.kind !== 'template'), recentHuman: Boolean(lastHuman) };
  } catch {
    return { replyToHuman: false, recentHuman: false };
  }
}

/** رسالة واردة من webhook ⇒ { kind, text, mediaId } قابلة للعرض. */
export function describeInbound(m) {
  switch (m?.type) {
    case 'text': return { kind: 'text', text: m.text?.body };
    case 'image': return { kind: 'image', text: m.image?.caption, mediaId: m.image?.id };
    case 'document': {
      const isImg = /^image\//.test(m.document?.mime_type || '');
      return { kind: isImg ? 'image' : 'document', text: m.document?.caption || m.document?.filename || '[ملف]', mediaId: isImg ? m.document?.id : null };
    }
    case 'interactive': {
      if (m.interactive?.type === 'nfm_reply') return { kind: 'button', text: describeFormReply(m.interactive.nfm_reply?.response_json) };
      const r = m.interactive?.button_reply || m.interactive?.list_reply;
      return { kind: 'button', text: r ? `🔘 ${r.title}` : '[ردّ تفاعلي]' };
    }
    case 'button': return { kind: 'button', text: `🔘 ${m.button?.text || m.button?.payload || ''}` };
    case 'audio': return { kind: 'audio', text: '🎤 رسالة صوتية (لا يقرأها البوت)' };
    case 'video': return { kind: 'other', text: '🎬 فيديو (لا يقرأه البوت)' };
    case 'sticker': return { kind: 'other', text: '[ملصق]' };
    case 'location': return { kind: 'other', text: `📍 موقع ${m.location?.name || ''}`.trim() };
    case 'contacts': return { kind: 'other', text: '👤 جهة اتصال' };
    case 'reaction': return { kind: 'other', text: `تفاعل ${m.reaction?.emoji || ''}`.trim() };
    default: return { kind: 'other', text: `[${m?.type || 'رسالة'}]` };
  }
}

/** حمولة sendRaw ⇒ { kind, text } قابلة للعرض. */
export function describeOutbound(p) {
  if (p?.type === 'text') return { kind: 'text', text: p.text?.body };
  if (p?.type === 'image') return { kind: 'image', text: p.image?.caption || '[صورة]' };
  if (p?.type === 'template') {
    const params = (p.template?.components || [])
      .filter(c => c.type === 'body').flatMap(c => c.parameters || []).map(x => x.text).filter(Boolean);
    return { kind: 'template', text: `📄 قالب «${p.template?.name}»\n${params.join('\n')}` };
  }
  if (p?.type === 'interactive') {
    const i = p.interactive || {};
    const opts = i.type === 'list'
      ? (i.action?.sections || []).flatMap(s => s.rows || []).map(r => r.title)
      : (i.action?.buttons || []).map(b => b.reply?.title);
    return { kind: i.type === 'list' ? 'list' : 'interactive', text: `${i.body?.text || ''}\n${opts.filter(Boolean).map(t => `[${t}]`).join(' ')}` };
  }
  return { kind: 'other', text: `[${p?.type || 'رسالة'}]` };
}
