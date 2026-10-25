// ════════════════════════════════════════════════════════════════════════════
// dispatch.notify.js — سجلّ ناقلات إشعار المندوب (تلكرام/فايبر/واتساب).
//
// كل بوت يسجّل دالة sendText الخاصة به عند تحميل وحدته — بلا استيراد دائري:
// خدمات البوتات تستورد bot-order-flow الذي يستورد وحدة الإرسال للمذاخر.
// ════════════════════════════════════════════════════════════════════════════

const notifiers = new Map(); // transport → (chatId, text) => Promise

export function registerNotifier(transport, sendText) {
  notifiers.set(transport, sendText);
}

/** إشعار المحادثة التي وصلت منها الطلبية. لا يرمي أبداً. */
export async function notifyOrigin(dispatch, text) {
  const send = notifiers.get(dispatch?.originTransport);
  if (!send || !dispatch.originChatId) return;
  try {
    await send(dispatch.originChatId, text);
  } catch (e) {
    console.error(`[dispatch] تعذّر إشعار ${dispatch.originTransport}:`, e?.message);
  }
}
