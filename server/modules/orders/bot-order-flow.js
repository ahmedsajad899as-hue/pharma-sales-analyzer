// ════════════════════════════════════════════════════════════════════════════
// bot-order-flow.js — المفصل المحيّد للمنصة: الشيء الوحيد الذي يستورده
// telegram.service.js و viber.service.js لمعالجة طلبية.
//
// لا برومبت ولا نداء Gemini ولا كتابة Prisma في أي من وحدتي البوتين — كلها هنا،
// فإضافة منصة ثالثة لاحقاً (واتس اب) تعني كتابة transport فقط.
//
// عقد transport:
//   { name: 'telegram'|'viber'|'whatsapp',
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
import { ingestBotOrder, enrichRowsFromCatalog, attachScientificRepGuess, findPendingOrderForReveal } from './orders.service.js';
import { checkManualDuplicates, duplicateWarningText } from '../../lib/manualDuplicateCheck.js';
import { hasPersonalSaleTrigger, stripPersonalSaleTrigger } from '../province-teams/personal-sale-trigger.js';
import { ingestPersonalSalesFromBot } from '../province-teams/personal-sales.service.js';
import { renderOrderTablePng, paginateOrderRows } from './order-table-image.js';
import { matchBotInvoice, attachBotInvoice } from '../rep-orders/rep-orders.invoice.js';
import { userFeatureOn } from '../../lib/userFeatures.js';

// نوعا ما يصل للبوت (طلب صاحب المشروع 2026-10-31)، لكلٍّ مفتاح في «المميزات» لكل حساب:
//  • BOT_TO_CONDITION — طلبيات/فواتير البوت ← ملف الكوديشن (مفعّلة افتراضياً، السلوك القديم).
//  • BOT_TO_REP_ORDERS — صورة فاتورة تطابق طلبية من «طلبيات المذاخر» ← تُثبَّت عليها (اشتراك).
// الترتيب: المطابقة أولاً، وما لا يطابق يكمل للكوديشن.
const BOT_TO_CONDITION = 'bot_invoice_condition';
const BOT_TO_REP_ORDERS = 'bot_invoice_rep_orders';
// كلمة مع الصورة تحسم النوع: «مبيعات/كوديشن» ⇒ كوديشن بلا مطابقة؛ «#16» أو «تجهيز 16» ⇒ تلك الطلبية
const FORCE_SALE_RE = /مبيعات|مبيع|كوديشن|كونديشن/;
const repOrderIdIn = (text) => {
  const t = String(text ?? '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660));
  const m = t.match(/#\s*(\d{1,7})(?!\d)/) || t.match(/تجهيز\s*#?\s*(\d{1,7})(?!\d)/);
  return m ? Number(m[1]) : null;
};

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
  const toCondition = userFeatureOn(user, BOT_TO_CONDITION);
  const toRepOrders = hasMedia && mediaRefs.length === 1 && !FORCE_SALE_RE.test(String(text ?? ''))
    && userFeatureOn(user, BOT_TO_REP_ORDERS, { optIn: true });
  // لا مسار مفعّل لهذه الرسالة ⇒ ليست لنا (ولا نصرف قراءة ذكاء عليها)
  if (!toCondition && !toRepOrders) return false;

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

    // فاتورة تجهيز لطلبية مذاخر؟ (الصورة قُرئت أعلاه مرة واحدة لكلا المسارين)
    if (toRepOrders && imageBuffers.length === 1) {
      const forcedOrderId = repOrderIdIn(text);
      let match = null;
      try {
        match = await matchBotInvoice(user.id, rows, { forcedOrderId });
      } catch (e) {
        console.error('[orders] مطابقة فاتورة البوت بطلبيات المذاخر:', e?.message);
      }
      if (match) {
        const r = await attachBotInvoice(user.id, match, imageBuffers[0]);
        const o = match.order;
        await reply(transport, ctx,
          `🧾 فاتورة تجهيز — ثُبّتت على طلبية المذاخر #${o.id}`
          + `${o.pharmacyName ? ` (${o.pharmacyName})` : ''} عند ${r.warehouseName || 'المذخر'}`
          + `\nطابقت ${r.matchedLines}/${r.totalLines} صنف — ${r.complete ? '✅ الطلبية مكتملة التجهيز' : r.outcome === 'partial' ? '⚠️ تجهيز جزئي' : 'سُجّل التجهيز'}`
          + (r.awaitingName ? `\nℹ️ المذخر حسب اسمه المطبوع في الفاتورة — الطلبية كانت مُرسلة لـ ${r.awaitingName}.` : '')
          + `\nإن كانت مبيعات لا تجهيزاً: أعد إرسالها واكتب معها «مبيعات».`);
        return true;
      }
      if (forcedOrderId) {
        await reply(transport, ctx, `⚠️ لم أجد أصناف طلبية المذاخر #${forcedOrderId} في هذه الفاتورة (أو الطلبية ليست ضمن طلبياتك). ثبّتها من صفحة «طلبيات المذاخر».`);
        return true;
      }
      if (!toCondition) {
        await reply(transport, ctx, '⚠️ لم تطابق الفاتورة أي طلبية مذاخر مفتوحة. أعد إرسالها مع رقم الطلبية (مثل «#16»)، أو ثبّتها من صفحة «طلبيات المذاخر».');
        return true;
      }
      // لم تطابق ⇒ مبيعات للكوديشن كالمعتاد
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
      sourceMessageId: messageId,
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

// ─── «كشف» — صورة جدول التحليل عند الطلب فقط ────────────────────────────────
// (طلب صاحب المشروع 2026-10-19) الصورة لا تُرسَل تلقائياً بعد التحليل، بل حين
// يكتب أحد في الكروب «كشف» — ولو كان الكروب صامتاً: الكلمة طلب صريح.
// «كشف» ردّاً على رسالة الطلبية (أو ردّ البوت عليها) ← تلك الطلبية؛ «كشف 88» ←
// الطلبية 88؛ «كشف» وحدها ← **كل** الطلبيات المعلَّقة في الكروب (صور متتالية
// بحدّ 40 صنفاً للصورة، بلا شطر طلبية بين صورتين).
const REVEAL_RE = /^\s*كشف(?:\s*#?\s*(\d+))?\s*[.!؟?]*\s*$/;

/** null إن لم تكن الرسالة أمر «كشف»، وإلا { orderId|null }. */
export function parseRevealCommand(text) {
  const m = String(text ?? '').match(REVEAL_RE);
  return m ? { orderId: m[1] ? Number(m[1]) : null } : null;
}

/**
 * يرسل صورة الجدول للطلبية المقصودة. الإرسال بـforce (تخطّي وضع الصمت). لا يرمي.
 */
export async function handleRevealCommand({ transport, chatId, orderId = null, messageId = null, replyToMessageId = null, replyText = '' }) {
  try {
    const found = await findPendingOrderForReveal({ chatId, orderId, replyToMessageId, replyText });
    if (!found || !found.rows.length) {
      await transport.sendText(chatId, orderId
        ? `⚠️ لا توجد طلبية #${orderId} بانتظار المراجعة في هذا الكروب (ربما حُفظت أو أُلغيت).`
        : '⚠️ لا توجد طلبية بانتظار المراجعة لهذا الطلب (ربما حُفظت أو أُلغيت).', { force: true });
      return;
    }
    const pages = paginateOrderRows(found.rows);
    for (let p = 0; p < pages.length; p++) {
      const pageIds = [...new Set(pages[p].map(r => r._orderId))];
      // العنوان يبدأ بعربي ولا ينتهي بلاتيني (فخّ اتجاه السطر في resvg).
      const title = found.all
        ? `كشف الطلبيات بانتظار التأكيد${pages.length > 1 ? ` — صورة ${p + 1} من ${pages.length}` : ''}`
        : `كشف الطلبية رقم ${pageIds.join(' و ')}`;
      const png = await renderOrderTablePng(pages[p], {
        title,
        footer: 'هذه قراءة الذكاء الاصطناعي قبل تدقيق المدير — إن وجدت خطأ فاكتبه هنا',
      });
      await transport.sendPhoto(chatId, png, { replyTo: p === 0 ? messageId : null, force: true });
    }
  } catch (e) {
    console.error('[orders] تعذّر تنفيذ «كشف»:', e?.message);
  }
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
