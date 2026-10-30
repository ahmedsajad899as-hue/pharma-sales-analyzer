// ════════════════════════════════════════════════════════════════════════════
// rep-orders.controller.js — واجهة HTTP لـ«طلبيات المذاخر». الصلاحيات كلها في
// الخدمة (نطاق المُشاهِد)؛ هنا تمرير الطلب والرد فقط.
// ════════════════════════════════════════════════════════════════════════════

import * as svc from './rep-orders.service.js';
import * as invoice from './rep-orders.invoice.js';
import { createFromRepOrder } from '../warehouse-dispatch/dispatch.core.js';

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

export const listOrders      = wrap(async (req, res) => res.json({ success: true, ...(await svc.listOrders(req.user, req.query)) }));
// وضع «إرسال للمذاخر» لكاتب الطلبية: فوري ⇒ تُرسل عبر البوت الآن، بعد الموافقة ⇒ تنتظر المدير.
// فقط إن كانت «إرسال عبر البوت» مفعّلة في الصفحة (viaBot) — مطفأة = المندوب يرسل بنفسه.
const withDispatch = async (order, viaBot) => {
  const d = await createFromRepOrder(order.id, { allowNew: viaBot === true });
  return { success: true, order, dispatch: d ? { id: d.id, status: d.status, warehouseName: d.warehouseName, error: d.error } : null };
};
export const createOrder     = wrap(async (req, res) => res.json(await withDispatch(await svc.createOrder(req.user, req.body), req.body?.viaBot)));
export const updateOrder     = wrap(async (req, res) => res.json(await withDispatch(await svc.updateOrder(req.user, req.params.id, req.body), req.body?.viaBot)));
export const deleteOrder     = wrap(async (req, res) => { await svc.deleteOrder(req.user, req.params.id); res.json({ success: true }); });
export const setStatus       = wrap(async (req, res) => res.json({ success: true, ...(await svc.setStatus(req.user, req.body?.ids, req.body?.status)) }));
export const markSent        = wrap(async (req, res) => res.json({ success: true, ...(await svc.markSent(req.user, req.body?.ids, req.body?.warehouseId)) }));
export const attachImage     = wrap(async (req, res) => res.json({ success: true, ...(await svc.attachImage(req.user, req.params.id, req.params.kind, req.file)) }));
export const removeImage     = wrap(async (req, res) => { await svc.removeImage(req.user, req.params.id, req.params.kind); res.json({ success: true }); });
export const suggestions     = wrap(async (req, res) => res.json({ success: true, ...(await svc.suggestions(req.user)) }));

export const listWarehouses  = wrap(async (req, res) => res.json({ success: true, warehouses: await svc.listWarehouses(req.user) }));
export const createWarehouse = wrap(async (req, res) => res.json({ success: true, warehouse: await svc.createWarehouse(req.user, req.body) }));
export const updateWarehouse = wrap(async (req, res) => res.json({ success: true, warehouse: await svc.updateWarehouse(req.user, req.params.id, req.body) }));
export const deleteWarehouse = wrap(async (req, res) => { await svc.deleteWarehouse(req.user, req.params.id); res.json({ success: true }); });

export const readInvoice     = wrap(async (req, res) => res.json({ success: true, ...(await invoice.readInvoice(req.user, req.file)) }));
export const applyInvoice    = wrap(async (req, res) => res.json({ success: true, ...(await invoice.applyInvoice(req.user, req.params.id, req.body)) }));
export const prepareOrder    = wrap(async (req, res) => res.json({ success: true, ...(await svc.prepareOrder(req.user, req.params.id, req.body, req.file)) }));
