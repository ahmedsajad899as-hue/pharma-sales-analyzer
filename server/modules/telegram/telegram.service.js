// ════════════════════════════════════════════════════════════════════════════
// telegram.service.js — استقبال ملفات Excel عبر كروب تلكرام مربوط بحساب.
// بعد استلام الملف يُعرَض للمستخدم اختيار نوعه بأزرار (مبيعات/ارجاعات/مشترك/
// ستوك/زيارات أطباء)، ثم يُعالَج بالمسار المطابق:
//  - مبيعات/ارجاعات/مشترك → processUploadedFile (نفس مسار الرفع اليدوي).
//  - ستوك → parseMovementFile + ingestRows (نفس مسار uploadMovements، بلا
//    شاشة مراجعة أسماء تفاعلية — مطابق لمستوى المخاطرة بمسار المبيعات).
//  - زيارات أطباء → extractVisitsFromExcel فقط (بلا مطابقة/قبول تلقائي) —
//    النتيجة تُخزَّن كـPendingVisitsImport بانتظار مراجعة المستخدم يدوياً
//    بصفحة زيارات الأطباء بالتطبيق (لا استيراد نهائي عبر البوت لهذا النوع).
// راجع TelegramChatLink (prisma/schema*.prisma) لربط chatId ↔ userId.
// ════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { processUploadedFile } from '../sales/sales.service.js';
import { autoSyncIfOfficeEmployee } from '../sales/sales.controller.js';
import { parseMovementFile, ingestRows } from '../stock-ledger/stock-ledger.service.js';
import { resolveLedgerScope } from '../../lib/stockLedgerScope.js';
import { extractVisitsFromExcel } from '../doctors/doctor-visits-import.js';
import { handleIncomingOrderMessage } from '../orders/bot-order-flow.js';
import { hasTriggerWord } from '../orders/order-trigger.js';

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE   = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FILE_BASE  = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
// حد تلكرام لتنزيل ملف عبر getFile — أقل من حد الرفع اليدوي بالتطبيق (50 ميجا).
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXT = /\.(xlsx|xls|csv)$/i;

// ── ملفات بانتظار اختيار المستخدم لنوعها بالأزرار — ذاكرة العملية فقط ─────
// (uploadId) → { chatId, user, fileName, buffer, createdAt }. عمر افتراضي 15
// دقيقة؛ لا خطورة من فقدانها عند إعادة تشغيل السيرفر — المستخدم يعيد الإرسال.
const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingUploads = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingUploads) {
    if (now - entry.createdAt > PENDING_TTL_MS) pendingUploads.delete(id);
  }
}, 5 * 60 * 1000).unref();

async function telegramApi(method, body) {
  if (!BOT_TOKEN) { console.error(`[telegram] TELEGRAM_BOT_TOKEN غير مضبوط — تعذّر استدعاء ${method}`); return null; }
  try {
    const res = await fetch(`${API_BASE}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.error(`[telegram] ${method} failed:`, e.message);
    return null;
  }
}

const sendMessage        = (chatId, text, replyMarkup) => telegramApi('sendMessage', { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
const editMessageText     = (chatId, messageId, text, replyMarkup) => telegramApi('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup || { inline_keyboard: [] } });
const answerCallbackQuery = (id, text) => telegramApi('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });

async function downloadDocument(fileId) {
  const metaRes = await fetch(`${API_BASE}/getFile?file_id=${fileId}`);
  const meta = await metaRes.json();
  if (!meta.ok) throw new Error(meta.description || 'تعذّر جلب معلومات الملف من تلكرام');
  const fileRes = await fetch(`${FILE_BASE}/${meta.result.file_path}`);
  if (!fileRes.ok) throw new Error('تعذّر تنزيل الملف من تلكرام');
  return Buffer.from(await fileRes.arrayBuffer());
}

const fileTypeKeyboard = (uploadId) => ({
  inline_keyboard: [
    [{ text: 'مبيعات', callback_data: `ft:sales:${uploadId}` }, { text: 'ارجاعات', callback_data: `ft:returns:${uploadId}` }, { text: 'مشترك', callback_data: `ft:auto:${uploadId}` }],
    [{ text: '📦 ستوك', callback_data: `ft:stock:${uploadId}` }, { text: '🩺 زيارات أطباء', callback_data: `ft:visits:${uploadId}` }],
  ],
});
const stockKindKeyboard = (uploadId) => ({
  inline_keyboard: [
    [{ text: 'رصيد افتتاحي', callback_data: `sk:baseline:${uploadId}` }, { text: 'وارد', callback_data: `sk:in:${uploadId}` }, { text: 'صادر', callback_data: `sk:out:${uploadId}` }],
  ],
});

// ─── معالجات كل نوع ملف ──────────────────────────────────────────────────

async function processSalesUpload({ user, fileName, buffer }, fileType) {
  const result = await processUploadedFile(
    { buffer, originalname: fileName },
    { uploadedBy: user.username, userId: user.id, fileType, rawOriginalName: true },
  );

  try { await autoSyncIfOfficeEmployee(user, result?.uploadedFile?.id, 'auto'); }
  catch (syncErr) { console.error('[telegram] autoSyncIfOfficeEmployee failed:', syncErr); }

  const lines = [
    `✅ تم استيراد "${result.uploadedFile.originalName}"`,
    `الصفوف: ${result.rowCount} (مبيعات ${result.salesCount} / مرتجعات ${result.returnsCount})`,
  ];
  if (result.skipped) lines.push(`صفوف متجاهَلة: ${result.skipped}`);
  if (result.unknownItems?.length) lines.push(`⚠️ ايتمات غير معروفة: ${result.unknownItems.length}`);
  return lines.join('\n');
}

async function processStockUpload({ user, fileName, buffer }, kind) {
  const movementDate = new Date(); // دائماً اليوم — قرار المستخدم، لا سؤال بالمحادثة
  const { rows } = parseMovementFile(buffer, movementDate);
  if (!rows.length) {
    throw new AppError('لا توجد صفوف صالحة بالملف — تأكد من وجود أعمدة المذخر والايتم والكمية.', 422);
  }
  const { writeId } = await resolveLedgerScope(user);
  const label = { baseline: 'ستوك افتتاحي', in: 'تعزيز', out: 'مبيع من المذاخر' }[kind];
  const result = await ingestRows({ userId: writeId, kind, name: `${label}: ${fileName}`, movementDate, rows });
  return `✅ تم استيراد الستوك (${label})\nالصفوف: ${result.rowCount ?? 0} — المذاخر: ${result.warehouseCount ?? 0}`;
}

async function processVisitsUpload({ user, fileName, buffer }) {
  const already = await prisma.pendingVisitsImport.findUnique({ where: { userId: user.id } });
  if (already) {
    throw new AppError(
      `لديك ملف زيارات بانتظار المراجعة بالفعل ("${already.fileName}") — أكمله أو ألغِه من صفحة زيارات الأطباء بالتطبيق أولاً.`,
      409,
    );
  }

  const tmpPath = path.join(os.tmpdir(), `tg_visits_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.xlsx`);
  fs.writeFileSync(tmpPath, buffer);
  // extractVisitsFromExcel يحذف الملف المؤقت بنفسه بعد القراءة (finally داخلي).
  const data = await extractVisitsFromExcel({ path: tmpPath, originalname: fileName }, user);

  const docCount   = data.doctorRows?.length   || 0;
  const pharmCount = data.pharmacyRows?.length || 0;
  if (docCount === 0 && pharmCount === 0) {
    return '⚠️ لم يُستخرج أي صف صالح من الملف — تأكّد من وجود عمود اسم الطبيب (أو أنه بصيغة معروفة).';
  }

  await prisma.pendingVisitsImport.create({ data: { userId: user.id, fileName, payload: data } });
  return [
    `📋 تم رفع "${fileName}" (${docCount} طبيب / ${pharmCount} صيدلية)`,
    'بانتظار مراجعتك: افتح التطبيق ← صفحة زيارات الأطباء لإكمال مطابقة الأسماء والتأكيد.',
    'لا يُحفَظ أي شيء نهائياً حتى تراجعه وتؤكده هناك.',
  ].join('\n');
}

// ─── معالجة اختيار الزر (نوع الملف، ثم نوع حركة الستوك إن لزم) ───────────

async function handleCallbackQuery(cq, updateId) {
  await answerCallbackQuery(cq.id);

  const chatId    = String(cq.message?.chat?.id ?? '');
  const messageId = cq.message?.message_id;
  const [tag, value, uploadId] = String(cq.data || '').split(':');
  if (!chatId || !messageId || !uploadId) return;

  // نفس حارس التكرار المستخدم لرسائل المستندات — update_id متسلسل عبر كل
  // أنواع التحديثات بنفس البوت، فيصلح دليل تكرار عاماً هنا أيضاً.
  const link = await prisma.telegramChatLink.findUnique({ where: { chatId } });
  if (link && await isDuplicateUpdate(link, updateId, { deferWrite: false })) return;

  const entry = pendingUploads.get(uploadId);
  if (!entry) {
    await editMessageText(chatId, messageId, '⚠️ انتهت صلاحية هذا الطلب — أعد إرسال الملف من جديد.');
    return;
  }

  if (tag === 'ft' && value === 'stock') {
    await editMessageText(chatId, messageId, `📎 "${entry.fileName}" — اختر نوع حركة الستوك:`, stockKindKeyboard(uploadId));
    return; // بانتظار اختيار sk:<kind> — يبقى entry بالذاكرة
  }

  pendingUploads.delete(uploadId); // من هنا نعالج فعلياً؛ لا يُعاد استخدام نفس الاختيار

  try {
    let resultText;
    if (tag === 'ft' && (value === 'sales' || value === 'returns' || value === 'auto')) {
      resultText = await processSalesUpload(entry, value);
    } else if (tag === 'ft' && value === 'visits') {
      resultText = await processVisitsUpload(entry);
    } else if (tag === 'sk') {
      resultText = await processStockUpload(entry, value);
    } else {
      resultText = '⚠️ اختيار غير معروف — أعد إرسال الملف.';
    }
    await editMessageText(chatId, messageId, resultText);
  } catch (err) {
    console.error('[telegram] processing failed:', err);
    // AppError.isOperational → رسالتها جاهزة وآمنة للعرض؛ غيرها fallback عام
    // بلا تفاصيل تقنية (لا Stack trace يصل الكروب مهما حصل).
    const msg = err?.isOperational ? err.message : 'فشل استيراد الملف. تأكد أنه ملف إكسل/CSV صحيح، أو تواصل مع الأدمن.';
    await editMessageText(chatId, messageId, `⚠️ ${msg}`);
  }
}

// ─── حارس التكرار ────────────────────────────────────────────────────────────
// كان الحارس عموداً واحداً (lastUpdateId) يُقارَن بـ«أصغر أو يساوي». مع ملف إكسل
// كل عشر دقائق كان كافياً، لكن **ألبوم الصور يكسره**: تلكرام يسلّم ألبوم 5 صور
// كخمسة طلبات ويب-هوك منفصلة بـupdate_id متتالية، والكونترولر يُقرّ كل واحدة
// ويعالجها fire-and-forget — فتتشابك خمس عمليات قراءة/كتابة، وأول من يكتب N+4
// يجعل الأربع الباقية تبدو قديمة فتُسقَط بصمت.
//
// الحلّ: مجموعة في الذاكرة للتكرار الحقيقي (نفس update_id مرتين)، ويبقى العمود
// أرضيةً بعد إعادة التشغيل تُكتب بـ«الأكبر» ذرّياً لا بكتابة عمياء. النتيجة تُقلّل
// الرفض الخاطئ ولا تزيده.
const SEEN_UPDATE_TTL_MS = 10 * 60 * 1000;
const SEEN_UPDATE_MAX    = 1000;
const seenUpdates = new Map(); // update_id → ts
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of seenUpdates) if (now - ts > SEEN_UPDATE_TTL_MS) seenUpdates.delete(id);
}, 5 * 60 * 1000).unref();

const markSeen = (updateId) => {
  seenUpdates.set(updateId, Date.now());
  while (seenUpdates.size > SEEN_UPDATE_MAX) seenUpdates.delete(seenUpdates.keys().next().value);
};

/** كتابة «الأكبر» ذرّياً — لا تتراجع الأرضية عند تشابك تحديثات ألبوم واحد. */
async function markUpdateConsumed(link, updateId) {
  if (!Number.isFinite(updateId)) return;
  await prisma.telegramChatLink.updateMany({
    where: { chatId: link.chatId, OR: [{ lastUpdateId: null }, { lastUpdateId: { lt: updateId } }] },
    data:  { lastUpdateId: updateId },
  }).catch(e => console.error('[telegram] تعذّر تحديث lastUpdateId:', e?.message));
}

/**
 * true ⇒ تحديث مكرَّر يجب تخطّيه.
 *
 * deferWrite: false يعيد دلالات ما قبل الميزة بالضبط (الأرضية تُكتب قبل العمل) —
 * مطلوب لمسار المستند: إكسل مُعاد التسليم بعد انهيار يجب ألّا يُستورد مرتين إلى
 * صفوف Sale حقيقية. و true يؤجّل الكتابة لما بعد المعالجة، وهو آمن لمسار
 * الطلبيات لأن إعادة التسليم تُنتج صفاً *معلَّقاً* يراجعه إنسان، وsourceHash
 * يطويه أصلاً.
 */
async function isDuplicateUpdate(link, updateId, { deferWrite }) {
  if (!Number.isFinite(updateId)) return false;
  if (seenUpdates.has(updateId)) return true;
  if (link.lastUpdateId != null && updateId <= link.lastUpdateId) return true;
  markSeen(updateId);
  if (!deferWrite) await markUpdateConsumed(link, updateId);
  return false;
}

// ─── تصنيف الرسالة ──────────────────────────────────────────────────────────

/**
 * 'document' | 'photo' | 'text' | null.
 *
 * الرسائل الصوتية والفيديو مُستثناة **بقرار صريح** من صاحب المشروع: نطاق الميزة
 * نصّ وصور فقط. لا تُضَف هنا «مساعدةً» — الصوت يحتاج برومبتاً ومعالجة لهجة
 * واختباراً خاصاً به، وإضافته صامتةً تُدخل بيانات لم يراجعها أحد.
 */
function classifyMessage(message) {
  if (!message) return null;
  if (message.document) return 'document';
  if (Array.isArray(message.photo) && message.photo.length) return 'photo';
  if (message.voice || message.audio || message.video_note || message.video) return null;
  if (typeof message.text === 'string' && message.text.trim()) return 'text';
  return null;
}

const senderNameOf = (message) => {
  const f = message?.from;
  if (!f) return null;
  return [f.first_name, f.last_name].filter(Boolean).join(' ').trim() || f.username || null;
};

const isReplyToBotMsg = (message) => message?.reply_to_message?.from?.is_bot === true;

/**
 * يحلّ الحساب الفاعل من الكروب. يُعيد null بعد أن يكون قد ردّ بالسبب — أو صمت
 * عمداً.
 *
 * `announce`: هل يجوز الردّ على كروب غير مربوط/معطَّل؟ ردّ الاكتشاف يطبع chatId
 * الخام ليربطه الأدمن، وكان مقبولاً حين لا يصل هذا المسار إلا ملفٌّ مقصود. لكن
 * مع وصول النصوص صار إزعاجاً في كل كروب غير مربوط عند كل رسالة — فنُعلن فقط حين
 * تكون النيّة واضحة: ملف، أو كلمة «طلبية»، أو ردّ على البوت.
 */
async function resolveActor(message, { announce }) {
  const chatId = String(message.chat.id);
  const link = await prisma.telegramChatLink.findUnique({ where: { chatId } });

  if (!link) {
    if (announce) {
      await sendMessage(chatId, `هذا الكروب غير مربوط بأي حساب بعد.\nشارك هذا الرقم مع الأدمن ليربطه: ${chatId}`);
    }
    return null;
  }
  if (!link.isActive) {
    if (announce) await sendMessage(chatId, 'الربط معطّل حالياً لهذا الكروب — تواصل مع الأدمن.');
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: link.userId } });
  if (!user || !user.isActive) {
    if (announce) await sendMessage(chatId, '⚠️ الحساب المرتبط بهذا الكروب غير فعّال — تواصل مع الأدمن.');
    return null;
  }

  return { chatId, chatTitle: message.chat.title || null, link, user };
}

// ─── مسار المستند (سلوك ما قبل الميزة، منقول كما هو) ────────────────────────

async function handleDocumentMessage(actor, message) {
  const { chatId, user } = actor;
  const document = message.document;
  const fileName = document.file_name || 'file.xlsx';

  if (!ALLOWED_EXT.test(fileName)) {
    await sendMessage(chatId, `⚠️ صيغة الملف "${fileName}" غير مدعومة — أرسل ملف xlsx أو xls أو csv فقط.`);
    return;
  }
  if (document.file_size && document.file_size > MAX_TELEGRAM_FILE_BYTES) {
    await sendMessage(chatId, '⚠️ الملف أكبر من 20 ميجا (حد تلكرام لتنزيل الملفات) — ارفعه من الموقع مباشرة.');
    return;
  }

  try {
    const buffer   = await downloadDocument(document.file_id);
    const uploadId = crypto.randomBytes(4).toString('hex');
    pendingUploads.set(uploadId, { chatId, user, fileName, buffer, createdAt: Date.now() });
    await sendMessage(chatId, `📎 "${fileName}" — شنو نوع هذا الملف؟`, fileTypeKeyboard(uploadId));
  } catch (err) {
    console.error('[telegram] download failed:', err);
    await sendMessage(chatId, '⚠️ تعذّر تنزيل الملف من تلكرام، حاول مرة أخرى.');
  }
}

// ─── مسار الطلبيات (نص/صور) ─────────────────────────────────────────────────

/** عقد المنصة الذي يفهمه bot-order-flow — تلكرام يملك تعديل الرسائل. */
const telegramTransport = {
  name: 'telegram',
  sendText: async (chatId, text) => (await sendMessage(chatId, text))?.result?.message_id ?? null,
  editText: (chatId, messageId, text) => editMessageText(chatId, messageId, text),
  // getFile محيّد لنوع الملف — معرّف صورة يمرّ بنفس المسار بلا تعديل.
  downloadMedia: (fileId) => downloadDocument(fileId),
};

// ألبوم صور واحد = طلبية واحدة لا N طلبيات. تلكرام يسلّم كل صورة في تحديث منفصل
// ويضع الكابشن على عضو واحد فقط (الأول عادةً) — فقرار «هل هذه طلبية؟» **يجب** أن
// يُؤجَّل لما بعد اكتمال المجموعة، وإلا حُكم على الألبوم من عضو بلا كابشن فسقط.
const ALBUM_DEBOUNCE_MS = 2500;
const MAX_ALBUM_PHOTOS  = 10;
const MAX_ALBUM_GROUPS  = 50;
const albumBuffer = new Map(); // media_group_id → { actor, caption, mediaRefs, updateIds, ... }

async function flushAlbum(groupId) {
  const g = albumBuffer.get(groupId);
  if (!g) return;
  albumBuffer.delete(groupId);
  try {
    await handleIncomingOrderMessage({
      transport: telegramTransport,
      link: g.actor.link, user: g.actor.user,
      chatId: g.actor.chatId, chatTitle: g.actor.chatTitle,
      senderName: g.senderName,
      text: g.caption,
      mediaRefs: g.mediaRefs,
      isReplyToBot: g.isReplyToBot,
    });
  } catch (err) {
    console.error('[telegram] فشل تفريغ ألبوم الصور:', err);
  } finally {
    // الأرضية تتقدّم مرة واحدة لكل المجموعة، لأكبر update_id فيها.
    await markUpdateConsumed(g.actor.link, Math.max(...g.updateIds));
  }
}

function bufferAlbumPhoto(actor, message, fileId, updateId) {
  const groupId = message.media_group_id;
  let g = albumBuffer.get(groupId);
  if (!g) {
    if (albumBuffer.size >= MAX_ALBUM_GROUPS) return; // حارس ذاكرة — تُهمَل مجموعة جديدة
    g = {
      actor, senderName: senderNameOf(message), caption: '',
      mediaRefs: [], updateIds: [], isReplyToBot: false, timer: null,
    };
    albumBuffer.set(groupId, g);
  }
  if (g.mediaRefs.length < MAX_ALBUM_PHOTOS) g.mediaRefs.push(fileId);
  g.updateIds.push(updateId);
  const caption = String(message.caption || '').trim();
  if (caption && !g.caption) g.caption = caption; // الكابشن على عضو واحد فقط
  if (isReplyToBotMsg(message)) g.isReplyToBot = true;

  if (g.timer) clearTimeout(g.timer);
  g.timer = setTimeout(() => { flushAlbum(groupId); }, ALBUM_DEBOUNCE_MS);
  g.timer.unref?.();
}

async function handleOrderMessage(actor, message, kind, updateId) {
  const common = {
    transport: telegramTransport,
    link: actor.link, user: actor.user,
    chatId: actor.chatId, chatTitle: actor.chatTitle,
    senderName: senderNameOf(message),
    isReplyToBot: isReplyToBotMsg(message),
  };

  if (kind === 'photo') {
    const photos = message.photo;
    const fileId = photos[photos.length - 1].file_id; // أكبر مقاس متاح
    if (message.media_group_id) { bufferAlbumPhoto(actor, message, fileId, updateId); return; }
    await handleIncomingOrderMessage({
      ...common,
      text: String(message.caption || '').trim(),
      mediaRefs: [fileId],
    });
    return;
  }

  await handleIncomingOrderMessage({ ...common, text: message.text, mediaRefs: [] });
}

/**
 * يعالج تحديث واحد قادم من ويب-هوك تلكرام — لا يُستدعى إلا بعد التحقق من رمز
 * السر بالكونترولر. لا يرمي أبداً (كل خطأ يُترجم لرد بالكروب بدل تعطيل الويب-هوك).
 */
export async function handleUpdate(update) {
  if (update?.callback_query) { await handleCallbackQuery(update.callback_query, update.update_id); return; }

  const message = update?.message;
  const kind = classifyMessage(message);
  if (!kind) return; // ستيكر/رسالة خدمة/صوت — تجاهل بصمت

  const intentText = kind === 'photo' ? String(message.caption || '') : String(message.text || '');
  const announce = kind === 'document' || hasTriggerWord(intentText) || isReplyToBotMsg(message);

  const actor = await resolveActor(message, { announce });
  if (!actor) return;

  if (kind === 'document') {
    if (await isDuplicateUpdate(actor.link, update.update_id, { deferWrite: false })) return;
    await handleDocumentMessage(actor, message);
    return;
  }

  // مسار الطلبيات: الأرضية تُكتب **بعد** المعالجة (أو عند تفريغ الألبوم).
  if (await isDuplicateUpdate(actor.link, update.update_id, { deferWrite: true })) return;
  try {
    await handleOrderMessage(actor, message, kind, update.update_id);
  } finally {
    // الألبوم يتولّى تقديم أرضيته عند التفريغ — لا نتقدّم هنا كي لا نُسقط بقيته.
    if (!message.media_group_id) await markUpdateConsumed(actor.link, update.update_id);
  }
}
