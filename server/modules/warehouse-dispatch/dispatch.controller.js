// ════════════════════════════════════════════════════════════════════════════
// dispatch.controller.js — واجهة HTTP لـ«إرسال للمذاخر». الصلاحيات في الخدمة.
// ════════════════════════════════════════════════════════════════════════════

import * as svc from './dispatch.service.js';

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

export const list            = wrap(async (req, res) => res.json({ success: true, ...(await svc.listDispatches(req.user, req.query)) }));
export const update          = wrap(async (req, res) => res.json({ success: true, dispatch: await svc.updateDispatch(req.user, req.params.id, req.body) }));
export const send            = wrap(async (req, res) => res.json({ success: true, dispatch: await svc.sendNow(req.user, req.params.id, req.body) }));
export const forward         = wrap(async (req, res) => res.json({ success: true, dispatch: await svc.forwardNow(req.user, req.params.id, req.body) }));
export const setStatus       = wrap(async (req, res) => res.json({ success: true, dispatch: await svc.setManualStatus(req.user, req.params.id, req.body) }));
export const remove          = wrap(async (req, res) => { await svc.deleteDispatch(req.user, req.params.id); res.json({ success: true }); });
export const sendRepOrder    = wrap(async (req, res) => res.json({ success: true, dispatch: await svc.sendRepOrder(req.user, req.params.repOrderId, req.body) }));

export const listWarehouses  = wrap(async (req, res) => res.json({ success: true, warehouses: await svc.listWarehouses(req.user) }));
export const updateWarehouse = wrap(async (req, res) => res.json({ success: true, warehouse: await svc.updateWarehouseDispatch(req.user, req.params.id, req.body) }));

export const getSettings     = wrap(async (req, res) => res.json({ success: true, ...(await svc.getSettings(req.user)) }));
export const setUserMode     = wrap(async (req, res) => res.json({ success: true, setting: await svc.setUserMode(req.user, req.params.userId, req.body?.mode) }));
export const setConfig       = wrap(async (req, res) => res.json({ success: true, config: await svc.setConfig(req.user, req.body) }));

export const listGroups      = wrap(async (req, res) => res.json({ success: true, ...(await svc.listGroups(req.user)) }));
