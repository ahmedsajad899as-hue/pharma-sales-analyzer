// ════════════════════════════════════════════════════════════════════════════
// bot-order-flow.js — المفصل المحيّد للمنصة: الشيء الوحيد الذي يستورده
// telegram.service.js و viber.service.js لمعالجة طلبية.
//
// لا برومبت ولا نداء Gemini ولا كتابة Prisma في أي من وحدتي البوتين — كلها هنا،
// فإضافة منصة ثالثة لاحقاً (واتس اب) تعني كتابة transport فقط.
//
// عقد transport:
//   { name: 'telegram'|'viber',
//     sendText(chatId, text)        → Promise<messageId|null>
//     editText?(chatId, msgId, text) → Promise<any>   (فايبر لا يملكها)
//     downloadMedia(ref)            → Promise<Buffer> }
//
// **هذه الدالة لا ترمي أبداً**: webhook تلكرام يُقرّ 200 ثم ينسى
// (telegram.controller.js)، فأي رمية هنا تصبح unhandled rejection بلا أي إشعار
// للمستخدم — الطلبية تختفي صامتةً وهو يظنّها وصلت.
// ════════════════════════════════════════════════════════════════════════════

import { extractInvoiceRows } from '../sales/sales.service.js';
import { extractOrderRowsFromText } from './order-extract.js';
import { isOrderTrigger } from './order-trigger.js';
import { ingestBotOrder } from './orders.service.js';

/** يردّ بتعديل رسالة «⏳» حيث تدعم المنصة ذلك، وإلا برسالة جديدة (فايبر). */
async function reply(transport, ctx, text) {
  try {
    if (transport.editText && ctx.messageId) {
      await transport.editText(ctx.chatId, ctx.messageId, text);
    } else {
      await transport.sendText(ctx.chatId, text);
    }
  } catch (e) {
    console.error(`[orders] تعذّر الردّ على ${transport.name}:`, e?.message);
  }
}

/**
 * يعالج رسالة قد تكون طلبية. يُستدعى بعد حلّ الحساب المربوط وحارس التكرار.
 *
 * @param {object}   p
 * @param {object}   p.transport     عقد المنصة أعلاه
 * @param {object}   p.link          صف الربط (نحتاج orderTextMode منه)
 * @param {object}   p.user          صف User الكامل للحساب المربوط
 * @param {string}   p.chatId
 * @param {string}  [p.chatTitle]
 * @param {number}  [p.messageId]    رسالة المستخدم (للتشخيص فقط)
 * @param {string}  [p.senderName]   من كتب الطلبية فعلاً في الكروب
 * @param {string}  [p.text]         النص أو كابشن الصورة
 * @param {any[]}   [p.mediaRefs]    مراجع صور يفهمها transport.downloadMedia
 * @param {boolean} [p.isReplyToBot]
 * @returns {Promise<boolean>} true إذا عُوملت الرسالة كطلبية (أي استُهلكت)
 */
export async function handleIncomingOrderMessage({
  transport, link, user, chatId, chatTitle = null, messageId = null,
  senderName = null, text = '', mediaRefs = [], isReplyToBot = false,
}) {
  const hasMedia = mediaRefs.length > 0;
  if (!isOrderTrigger(text, link?.orderTextMode, { isReplyToBot, hasMedia })) return false;

  // من هنا الرسالة طلبية بنيّة المستخدم — كل خروج لاحق يجب أن يُخبره بشيء.
  const ctx = { chatId, messageId: null };
  try {
    ctx.messageId = await transport.sendText(chatId, '⏳ جاري قراءة الطلبية…');
  } catch (e) {
    console.error(`[orders] تعذّر إرسال رسالة الانتظار على ${transport.name}:`, e?.message);
  }

  try {
    let rows = [];
    let imageBuffers = [];

    if (hasMedia) {
      imageBuffers = (await Promise.all(
        mediaRefs.map(ref => transport.downloadMedia(ref).catch(err => {
          console.error('[orders] تعذّر تنزيل صورة:', err?.message);
          return null;
        })),
      )).filter(Boolean);

      if (!imageBuffers.length) {
        await reply(transport, ctx, '⚠️ تعذّر تنزيل الصورة من المحادثة — أعد إرسالها.');
        return true;
      }

      // صورة فاتورة/طلبية = بالضبط ما كُتب له extractInvoiceRows (بصناديق
      // التكبير)، فيُعاد استخدامه كما هو والكابشن يمرّ كسياق مساعد.
      rows = await extractInvoiceRows(
        imageBuffers.map(b => ({ mimeType: 'image/jpeg', base64: b.toString('base64') })),
        { extraContext: String(text ?? '').trim() || undefined },
      );
    } else {
      rows = await extractOrderRowsFromText(text, { todayISO: new Date().toISOString().slice(0, 10) });
    }

    if (!rows.length) {
      await reply(transport, ctx,
        '⚠️ لم أتعرّف على أصناف وكميات في هذه الرسالة.\n'
        + 'اكتب الطلبية بسطر لكل صنف مع كميته، مثال:\n'
        + 'طلبية صيدلية النور - الكرخ\nبانادول 5 علبة');
      return true;
    }

    const msg = await ingestBotOrder({
      user,
      source: transport.name,
      chatId, chatTitle, senderName,
      kind: hasMedia ? 'photo' : 'text',
      sourceText: String(text ?? '').trim() || null,
      rows,
      imageBuffers,
      mediaKeys: mediaRefs.map(r => (typeof r === 'string' ? r : JSON.stringify(r))),
    });
    await reply(transport, ctx, msg);
  } catch (err) {
    // نصّ AppError التشغيلي مفهوم للمستخدم ويُعرَض كما هو؛ غيره يُخفى كي لا يصل
    // stack trace إلى كروب مبيعات. نفس نمط handleCallbackQuery في تلكرام.
    console.error('[orders] فشل استقبال الطلبية:', err);
    await reply(transport, ctx,
      `⚠️ ${err?.isOperational ? err.message : 'تعذّر قراءة الطلبية. جرّب إعادة إرسالها، أو أدخلها يدوياً من التطبيق.'}`);
  }
  return true;
}
