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
import { matchInvoiceCustomers } from '../../lib/invoiceCustomerMatch.js';
import { extractOrderRowsFromText } from './order-extract.js';
import { isOrderTrigger, isExplicitOrderIntent } from './order-trigger.js';
import { ingestBotOrder, enrichRowsFromCatalog, attachScientificRepGuess } from './orders.service.js';
import { checkManualDuplicates, duplicateWarningText } from '../../lib/manualDuplicateCheck.js';
import { hasPersonalSaleTrigger, stripPersonalSaleTrigger } from '../province-teams/personal-sale-trigger.js';
import { ingestPersonalSalesFromBot } from '../province-teams/personal-sales.service.js';

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
  senderName = null, senderId = null, text = '', mediaRefs = [], isReplyToBot = false,
}) {
  const hasMedia = mediaRefs.length > 0;
  if (!isOrderTrigger(text, link?.orderTextMode, { isReplyToBot, hasMedia })) return false;

  // نيّة صريحة (كلمة «طلبية» أو ردّ على البوت) مقابل رسالة التقطها وضع «كل
  // الرسائل». الفرق يحكم مدى ثرثرة البوت:
  //  • صريحة → «⏳» فوراً وردّ على كل حال، حتى حين لا يجد أصنافاً.
  //  • غير صريحة → **صمت تام** ما لم يُستخرج شيء فعلاً. وإلا لامتلأ كروب المبيعات
  //    بردود «لم أتعرّف على أصناف» على كل رسالة فيها رقم.
  const explicit = isExplicitOrderIntent(text, { isReplyToBot });
  const ctx = { chatId, messageId: null };
  if (explicit) {
    try {
      ctx.messageId = await transport.sendText(chatId, '⏳ جاري قراءة الطلبية…');
    } catch (e) {
      console.error(`[orders] تعذّر إرسال رسالة الانتظار على ${transport.name}:`, e?.message);
    }
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
        // فشل تنزيل يُبلَّغ عنه دائماً: المستخدم أرسل صورة فعلاً وينتظر نتيجة.
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

    // مطابقة الأصناف بكتالوج المستخدم وتعبئة الشركة والسعر — لكلا المسارين
    // (نصّ وصورة) كي لا يفترق سلوكهما. لا يرمي ولا يحفظ شيئاً.
    await enrichRowsFromCatalog(rows, user.id);
    // الصيدلية/المنطقة المقروءة ← الأسماء القانونية من الماستر أدمن («منصور» ←
    // «المنصور»). قبل التخمين لأن المندوب العلمي يُستنتج من المنطقة.
    await matchInvoiceCustomers(rows);
    // التخمين بعد المطابقة لأنه يعتمد على معرّف الصنف وشركته العلمية.
    await attachScientificRepGuess(rows, user);
    // بديل التخمين: الصفوف التي لم تُحسم من المنطقة/الشركة/الصنف تُسجَّل باسم المندوب
    // الذي أرسلها فعلاً إن كان مربوطاً بحسابه من لوحة الماستر أدمن (👥 الأعضاء).
    // لا تَطغى على تخمين حُسم، ولا تُطبَّق إن لم يوجد ربط.
    if (rows.length && transport.resolveSenderRep && senderId != null) {
      try {
        const senderRep = await transport.resolveSenderRep(chatId, senderId);
        if (senderRep) for (const row of rows) if (!row.scientificRep) row.scientificRep = senderRep.name;
      } catch (e) {
        console.error('[orders] تعذّر حلّ مندوب المرسل:', e?.message);
      }
    }

    if (!rows.length) {
      // صورة مُرسَلة عمداً تستحق ردّاً حتى بلا كلمة مفتاحية؛ أما نصّ التقطه وضع
      // «كل الرسائل» فيُترك بصمت — دردشة عادية لا تحتاج اعتذاراً من البوت.
      if (explicit || hasMedia) {
        await reply(transport, ctx,
          '⚠️ لم أتعرّف على أصناف وكميات في هذه الرسالة.\n'
          + 'اكتب الطلبية بسطر لكل صنف مع كميته، مثال:\n'
          + 'صيدلية النور - الكرخ\nبانادول 5 علبة');
      }
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
    // تنبيه مبكر: الطلبية نفسها محفوظة سابقاً في ملف الكوديشن؟ (لا يمنع الطابور —
    // القرار للمراجِع في التطبيق، حيث تُعلَّم الصفوف المكررة أيضاً.)
    let dupNote = '';
    try {
      const dup = await checkManualDuplicates({
        rows: rows.map(r => ({ ...r, group: r._imageIndex != null ? `img${r._imageIndex}` : 'order' })),
        target: { condition: true }, userId: user.id, receivedAt: new Date(),
      });
      dupNote = duplicateWarningText(dup);
    } catch (e) {
      console.error('[orders] تعذّر فحص التكرار:', e?.message);
    }
    await reply(transport, ctx, msg + dupNote);
  } catch (err) {
    // نصّ AppError التشغيلي مفهوم للمستخدم ويُعرَض كما هو؛ غيره يُخفى كي لا يصل
    // stack trace إلى كروب مبيعات. نفس نمط handleCallbackQuery في تلكرام.
    console.error('[orders] فشل استقبال الطلبية:', err);
    // الأخطاء الفعلية تُبلَّغ دائماً — صمتٌ هنا يعني طلبية ضاعت بلا أن يعلم أحد.
    await reply(transport, ctx,
      `⚠️ ${err?.isOperational ? err.message : 'تعذّر قراءة الطلبية. جرّب إعادة إرسالها، أو أدخلها يدوياً من التطبيق.'}`);
  }
  return true;
}

/**
 * «الجهد الشخصي» من البوت: نفس استخراج الطلبية (نص أو صورة + مطابقة الكتالوج
 * والصيدلية) لكن الصفوف تذهب لطابور اعتماد التيم ليدر (RepPersonalSale) لا
 * لطابور الطلبيات، ولا تصل جدول Sale أبداً. الكلمة المفتاحية نيّة صريحة دائماً
 * فيردّ البوت على كل حال. لا يرمي — نفس عقد handleIncomingOrderMessage.
 */
async function handlePersonalSaleMessage({ transport, user, chatId, senderName = null, text = '', mediaRefs = [] }) {
  const ctx = { chatId, messageId: null };
  try {
    ctx.messageId = await transport.sendText(chatId, '⏳ جاري تسجيل مبيعك الشخصي…');
  } catch (e) {
    console.error(`[personal-sales] تعذّر إرسال رسالة الانتظار على ${transport.name}:`, e?.message);
  }

  try {
    const body = stripPersonalSaleTrigger(text);
    let rows = [];
    if (mediaRefs.length) {
      const buffers = (await Promise.all(
        mediaRefs.map(ref => transport.downloadMedia(ref).catch(() => null)),
      )).filter(Boolean);
      if (!buffers.length) {
        await reply(transport, ctx, '⚠️ تعذّر تنزيل الصورة من المحادثة — أعد إرسالها.');
        return true;
      }
      rows = await extractInvoiceRows(
        buffers.map(b => ({ mimeType: 'image/jpeg', base64: b.toString('base64') })),
        { extraContext: body || undefined },
      );
    } else if (body) {
      rows = await extractOrderRowsFromText(body, { todayISO: new Date().toISOString().slice(0, 10) });
    }

    await enrichRowsFromCatalog(rows, user.id);
    await matchInvoiceCustomers(rows);

    if (!rows.length) {
      await reply(transport, ctx,
        '⚠️ لم أتعرّف على أصناف وكميات. اكتب المبيع بسطر لكل صنف، مثال:\n'
        + 'مبيعي\nصيدلية النور - الكرخ\nبانادول 5 علبة');
      return true;
    }

    const msg = await ingestPersonalSalesFromBot({
      user,
      source: transport.name,
      senderName,
      sourceText: String(text ?? '').trim() || null,
      mediaKeys: mediaRefs.map(r => (typeof r === 'string' ? r : JSON.stringify(r))),
      rows,
    });
    await reply(transport, ctx, msg);
  } catch (err) {
    console.error('[personal-sales] فشل تسجيل الجهد الشخصي:', err);
    await reply(transport, ctx,
      `⚠️ ${err?.isOperational ? err.message : 'تعذّر تسجيل المبيع. جرّب إعادة إرساله، أو أدخله من التطبيق (فرق المحافظات ← الجهد الشخصي).'}`);
  }
  return true;
}
