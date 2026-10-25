// واتساب يرسل wa_id أرقاماً دولية بلا «+» (9647701234567). الأدمن يكتب الرقم كما
// يعرفه («0770 123 4567» أو «+964 770…») — نوحّده وإلا لن يطابق أي رسالة أبداً.
export const normalizeWaId = (v) => {
  let d = String(v ?? '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660)).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^07\d{9}$/.test(d)) d = '964' + d.slice(1); // رقم عراقي محلي
  return d;
};
