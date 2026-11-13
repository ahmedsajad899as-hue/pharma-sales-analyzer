// عبر أي بوت تُرسَل طلبيات المذخر حين «إرسال عبر البوت» مفعّلة — للشارة قرب اسمه
// (طلبيات المذاخر + لوحة الماستر «المذاخر والبوت»). ملف مستقل لتفادي الدوران
// rep-orders.service ↔ warehouse-dispatch/dispatch.core.
//   cloud  = البوت الرسمي (Cloud API) على رقم المذخر
//   group  = «رقم الكروبات» في كروب المذخر
//   off    = الإرسال الآلي موقوف لهذا المذخر (groupSendOn=false)
//   manual = لا بوت: يدوي، أو بلا رقم/كروب
import { normalizeWaId } from './waId.js';

export function warehouseBotVia(w) {
  if (!w) return 'manual';
  if (w.channel === 'group' ? !w.groupJid : w.channel === 'manual' || !normalizeWaId(w.waId || w.phone)) return 'manual';
  if (w.groupSendOn === false) return 'off';
  return w.channel === 'group' ? 'group' : 'cloud';
}

/** الحقول التي تحتاجها warehouseBotVia — لـ select في prisma. */
export const BOT_VIA_SELECT = { channel: true, groupJid: true, waId: true, phone: true, groupSendOn: true };
