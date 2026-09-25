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
  if (link) {
    if (link.lastUpdateId != null && updateId <= link.lastUpdateId) return;
    await prisma.telegramChatLink.update({ where: { chatId }, data: { lastUpdateId: updateId } });
  }

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

/**
 * يعالج تحديث واحد قادم من ويب-هوك تلكرام — لا يُستدعى إلا بعد التحقق من رمز
 * السر بالكونترولر. لا يرمي أبداً (كل خطأ يُترجم لرد بالكروب بدل تعطيل الويب-هوك).
 */
export async function handleUpdate(update) {
  if (update?.callback_query) { await handleCallbackQuery(update.callback_query, update.update_id); return; }

  const message = update?.message;
  if (!message?.document) return; // دردشة عادية بلا ملف — تجاهل بصمت

  const chatId   = String(message.chat.id);
  const document = message.document;

  const link = await prisma.telegramChatLink.findUnique({ where: { chatId } });

  if (!link) {
    await sendMessage(chatId, `هذا الكروب غير مربوط بأي حساب بعد.\nشارك هذا الرقم مع الأدمن ليربطه: ${chatId}`);
    return;
  }
  if (!link.isActive) {
    await sendMessage(chatId, 'الربط معطّل حالياً لهذا الكروب — تواصل مع الأدمن.');
    return;
  }

  // حارس التكرار: تلكرام قد يعيد إرسال نفس التحديث عند بطء/تأخر الاستجابة.
  if (link.lastUpdateId != null && update.update_id <= link.lastUpdateId) return;
  await prisma.telegramChatLink.update({ where: { chatId }, data: { lastUpdateId: update.update_id } });

  const fileName = document.file_name || 'file.xlsx';
  if (!ALLOWED_EXT.test(fileName)) {
    await sendMessage(chatId, `⚠️ صيغة الملف "${fileName}" غير مدعومة — أرسل ملف xlsx أو xls أو csv فقط.`);
    return;
  }
  if (document.file_size && document.file_size > MAX_TELEGRAM_FILE_BYTES) {
    await sendMessage(chatId, '⚠️ الملف أكبر من 20 ميجا (حد تلكرام لتنزيل الملفات) — ارفعه من الموقع مباشرة.');
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: link.userId } });
  if (!user || !user.isActive) {
    await sendMessage(chatId, '⚠️ الحساب المرتبط بهذا الكروب غير فعّال — تواصل مع الأدمن.');
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
