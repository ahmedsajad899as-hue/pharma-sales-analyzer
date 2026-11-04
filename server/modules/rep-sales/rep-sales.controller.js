// ════════════════════════════════════════════════════════════════════════════
// rep-sales.controller.js — واجهة HTTP لـ«مبيعات المندوبين». الصلاحيات كلها في الخدمة.
// ════════════════════════════════════════════════════════════════════════════

import * as svc from './rep-sales.service.js';

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

export const listSales   = wrap(async (req, res) => res.json({ success: true, ...(await svc.listSales(req.user, req.query)) }));
export const suggestions = wrap(async (req, res) => res.json({ success: true, ...(await svc.suggestions(req.user)) }));
export const provinceSummary = wrap(async (req, res) => res.json({ success: true, ...(await svc.provinceSummary(req.user, req.query)) }));
export const createSale  = wrap(async (req, res) => res.json({ success: true, sale: await svc.createSale(req.user, req.body?.data, req.file) }));
export const updateSale  = wrap(async (req, res) => res.json({ success: true, sale: await svc.updateSale(req.user, req.params.id, req.body) }));
export const deleteSale  = wrap(async (req, res) => { await svc.deleteSale(req.user, req.params.id); res.json({ success: true }); });
export const confirmSale = wrap(async (req, res) => res.json({ success: true, sale: await svc.confirmSale(req.user, req.params.id, req.body?.lines, req.file) }));
export const setStatus   = wrap(async (req, res) => res.json({ success: true, sale: await svc.setStatus(req.user, req.params.id, req.body?.status) }));
export const attachImage = wrap(async (req, res) => res.json({ success: true, ...(await svc.attachImage(req.user, req.params.id, req.file)) }));
export const removeImage = wrap(async (req, res) => { await svc.removeImage(req.user, req.params.id); res.json({ success: true }); });
