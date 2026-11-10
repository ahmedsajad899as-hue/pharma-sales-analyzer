// ════════════════════════════════════════════════════════════════════════════
// wa-chat-log.js — سجلّ محادثات رقم البوت الرسمي: كل رسالة واردة (من مندوب أو مذخر
// أو رقم غير مربوط) وكل رسالة صادرة من البوت. الغاية أن يرى المدير ومالك التطبيق
// ما يدور فعلاً في المحادثات (تبويب «المحادثات» في «إرسال للمذاخر»).
//
// best-effort: فشل التسجيل لا يمسّ الاستقبال ولا الإرسال أبداً.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';

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

export async function logWa(row) {
  try {
    await prisma.waMessageLog.create({
      data: {
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

// بعد ردّ يدوي من إنسان تصبح المحادثة «بشرية» لهذه المدة: كلام الطرف الآخر العادي
// لا يُقرأ كطلبية ولا يردّ عليه البوت (ولا يصرف توكنات) — الأزرار والصور و«تم/رفض»
// وكلمة «طلبية» الصريحة تبقى تعمل.
export const HUMAN_WINDOW_MS = 30 * 60 * 1000;

/** هل الرسالة ردّ على رسالة كتبها إنسان، أو جاءت خلال نافذة محادثة بشرية؟ */
export async function humanChatState(waId, contextId) {
  try {
    const [quoted, lastHuman] = await Promise.all([
      contextId ? prisma.waMessageLog.findFirst({ where: { waMessageId: String(contextId) }, select: { sentById: true } }) : null,
      prisma.waMessageLog.findFirst({
        where: { waId: String(waId), direction: 'out', sentById: { not: null }, error: null, createdAt: { gte: new Date(Date.now() - HUMAN_WINDOW_MS) } },
        select: { id: true },
      }),
    ]);
    return { replyToHuman: Boolean(quoted?.sentById), recentHuman: Boolean(lastHuman) };
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
