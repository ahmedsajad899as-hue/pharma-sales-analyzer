// ════════════════════════════════════════════════════════════════════════════
// rep-orders.controller.js — واجهة HTTP لـ«طلبيات المذاخر». الصلاحيات كلها في
// الخدمة (نطاق المُشاهِد)؛ هنا تمرير الطلب والرد فقط.
// ════════════════════════════════════════════════════════════════════════════

import * as svc from './rep-orders.service.js';

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

export const listOrders      = wrap(async (req, res) => res.json({ success: true, ...(await svc.listOrders(req.user, req.query)) }));
export const createOrder     = wrap(async (req, res) => res.json({ success: true, order: await svc.createOrder(req.user, req.body) }));
export const updateOrder     = wrap(async (req, res) => res.json({ success: true, order: await svc.updateOrder(req.user, req.params.id, req.body) }));
export const deleteOrder     = wrap(async (req, res) => { await svc.deleteOrder(req.user, req.params.id); res.json({ success: true }); });
export const setStatus       = wrap(async (req, res) => res.json({ success: true, ...(await svc.setStatus(req.user, req.body?.ids, req.body?.status)) }));
export const markSent        = wrap(async (req, res) => res.json({ success: true, ...(await svc.markSent(req.user, req.body?.ids)) }));
export const attachInvoice   = wrap(async (req, res) => res.json({ success: true, ...(await svc.attachInvoice(req.user, req.params.id, req.file)) }));
export const removeInvoice   = wrap(async (req, res) => { await svc.removeInvoice(req.user, req.params.id); res.json({ success: true }); });
export const suggestions     = wrap(async (req, res) => res.json({ success: true, ...(await svc.suggestions(req.user)) }));

export const listWarehouses  = wrap(async (req, res) => res.json({ success: true, warehouses: await svc.listWarehouses(req.user) }));
export const createWarehouse = wrap(async (req, res) => res.json({ success: true, warehouse: await svc.createWarehouse(req.user, req.body) }));
export const updateWarehouse = wrap(async (req, res) => res.json({ success: true, warehouse: await svc.updateWarehouse(req.user, req.params.id, req.body) }));
export const deleteWarehouse = wrap(async (req, res) => { await svc.deleteWarehouse(req.user, req.params.id); res.json({ success: true }); });
