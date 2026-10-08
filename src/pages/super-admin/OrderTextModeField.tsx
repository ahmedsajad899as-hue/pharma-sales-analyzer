import { UI } from './OfficesPage';

// وضع قراءة الطلبيات من رسائل الكروب — مشترك بين صفحتي ربط تلكرام وفايبر كي لا
// تفترق القيم عن قائمة ORDER_TEXT_MODES البيضاء في الخادم
// (server/modules/orders/order-trigger.js — الكونترولر يرفض أي قيمة أخرى).
export const ORDER_TEXT_MODES = ['off', 'trigger', 'all'] as const;
export type OrderTextMode = typeof ORDER_TEXT_MODES[number];

export const ORDER_MODE_LABEL: Record<OrderTextMode, string> = {
  off:     'معطّل — النصوص والصور تُتجاهل',
  trigger: 'يلزم كلمة «طلبية» (الافتراضي)',
  all:     'كل الرسائل — لكروب طلبيات مخصّص',
};

export const ORDER_MODE_SHORT: Record<OrderTextMode, string> = {
  off: 'طلبيات: معطّلة', trigger: 'طلبيات: بكلمة مفتاحية', all: 'طلبيات: كل الرسائل',
};

export function OrderTextModeField({ value, onChange }: {
  value?: string | null;
  onChange: (v: OrderTextMode) => void;
}) {
  const v = (ORDER_TEXT_MODES as readonly string[]).includes(value || '') ? (value as OrderTextMode) : 'trigger';
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 5 }}>
        قراءة الطلبيات من رسائل الكروب
      </label>
      <select
        value={v}
        onChange={e => onChange(e.target.value as OrderTextMode)}
        style={{ width: '100%', padding: '8px 12px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13.5, boxSizing: 'border-box', outline: 'none', color: UI.ink }}
      >
        {ORDER_TEXT_MODES.map(m => <option key={m} value={m}>{ORDER_MODE_LABEL[m]}</option>)}
      </select>
      <div style={{ fontSize: 11.5, color: UI.faint, marginTop: 6, lineHeight: 1.6 }}>
        الطلبية المكتوبة كلاماً أو المُرسَلة صورةً تُقرأ بالذكاء الاصطناعي وتنتظر
        مراجعة المستخدم في التطبيق — لا تُحفَظ كمبيعات تلقائياً أبداً.
        في وضع «يلزم كلمة» يجب أن تبدأ الرسالة بـ«طلبية» (أو تكون رداً على رسالة
        البوت)، وفي الصور تُكتب الكلمة في التعليق. استخدم «كل الرسائل» فقط لكروب
        مخصَّص للطلبيات، فهو يُحلّل كل رسالة فيها رقم.
      </div>
    </div>
  );
}
