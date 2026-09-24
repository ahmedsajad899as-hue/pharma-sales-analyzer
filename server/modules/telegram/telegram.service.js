// ════════════════════════════════════════════════════════════════════════════
// telegram.service.js — استقبال ملفات مبيعات Excel عبر كروب تلكرام مربوط بحساب،
// ومعالجتها بنفس مسار الرفع اليدوي (processUploadedFile)، مع رد تأكيد/خطأ بالكروب.
// راجع TelegramChatLink (prisma/schema*.prisma) لربط chatId ↔ userId.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { processUploadedFile } from '../sales/sales.service.js';
import { autoSyncIfOfficeEmployee } from '../sales/sales.controller.js';

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE   = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FILE_BASE  = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
// حد تلكرام لتنزيل ملف عبر getFile — أقل من حد الرفع اليدوي بالتطبيق (50 ميجا).
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXT = /\.(xlsx|xls|csv)$/i;

async function sendMessage(chatId, text) {
  if (!BOT_TOKEN) { console.error('[telegram] TELEGRAM_BOT_TOKEN غير مضبوط — تعذّر إرسال الرد:', text); return; }
  try {
    await fetch(`${API_BASE}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error('[telegram] sendMessage failed:', e.message);
  }
}

async function downloadDocument(fileId) {
  const metaRes = await fetch(`${API_BASE}/getFile?file_id=${fileId}`);
  const meta = await metaRes.json();
  if (!meta.ok) throw new Error(meta.description || 'تعذّر جلب معلومات الملف من تلكرام');
  const fileRes = await fetch(`${FILE_BASE}/${meta.result.file_path}`);
  if (!fileRes.ok) throw new Error('تعذّر تنزيل الملف من تلكرام');
  return Buffer.from(await fileRes.arrayBuffer());
}

/**
 * يعالج تحديث واحد قادم من ويب-هوك تلكرام — لا يُستدعى إلا بعد التحقق من رمز
 * السر بالكونترولر. لا يرمي أبداً (كل خطأ يُترجم لرد بالكروب بدل تعطيل الويب-هوك).
 */
export async function handleUpdate(update) {
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
    const buffer = await downloadDocument(document.file_id);
    const result = await processUploadedFile(
      { buffer, originalname: fileName },
      { uploadedBy: user.username, userId: user.id, fileType: 'auto', rawOriginalName: true },
    );

    try { await autoSyncIfOfficeEmployee(user, result?.uploadedFile?.id, 'auto'); }
    catch (syncErr) { console.error('[telegram] autoSyncIfOfficeEmployee failed:', syncErr); }

    const lines = [
      `✅ تم استيراد "${result.uploadedFile.originalName}"`,
      `الصفوف: ${result.rowCount} (مبيعات ${result.salesCount} / مرتجعات ${result.returnsCount})`,
    ];
    if (result.skipped) lines.push(`صفوف متجاهَلة: ${result.skipped}`);
    if (result.unknownItems?.length) lines.push(`⚠️ ايتمات غير معروفة: ${result.unknownItems.length}`);
    await sendMessage(chatId, lines.join('\n'));
  } catch (err) {
    console.error('[telegram] processUploadedFile failed:', err);
    // AppError.isOperational → رسالة عربية جاهزة وآمنة للعرض؛ غيرها fallback عام
    // بلا تفاصيل تقنية (لا Stack trace يصل الكروب مهما حصل).
    const msg = err?.isOperational ? err.message : 'فشل استيراد الملف. تأكد أنه ملف إكسل/CSV صحيح، أو تواصل مع الأدمن.';
    await sendMessage(chatId, `⚠️ ${msg}`);
  }
}
