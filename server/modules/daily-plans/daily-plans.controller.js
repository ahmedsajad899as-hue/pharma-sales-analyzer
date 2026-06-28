/**
 * Daily Plans Controller (البلان اليومي)
 * HTTP layer — delegates all logic to daily-plans.service.js.
 */

import * as service from './daily-plans.service.js';

// GET /api/daily-plans?date=YYYY-MM-DD[&repUserId=]
export async function getPlan(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const view = await service.getPlanView(ctx, req.query.date);
    res.json({ success: true, data: view });
  } catch (err) { next(err); }
}

// POST /api/daily-plans  { date, repUserId? }
export async function createPlan(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const plan = await service.createPlan(ctx, req.body?.date);
    res.status(201).json({ success: true, data: plan });
  } catch (err) { next(err); }
}

// POST /api/daily-plans/:id/entries
export async function addEntry(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const result = await service.addEntry(ctx, parseInt(req.params.id), req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
}

// PATCH /api/daily-plans/entries/:entryId
export async function updateEntry(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const entry = await service.updateEntry(ctx, parseInt(req.params.entryId), req.body);
    res.json({ success: true, data: entry });
  } catch (err) { next(err); }
}

// DELETE /api/daily-plans/entries/:entryId
export async function removeEntry(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const result = await service.removeEntry(ctx, parseInt(req.params.entryId));
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

// POST /api/daily-plans/:id/entries/:entryId/record-visit
export async function recordVisit(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const visit = await service.recordVisit(ctx, parseInt(req.params.entryId), req.body);
    res.status(201).json({ success: true, data: visit });
  } catch (err) { next(err); }
}

// GET /api/daily-plans/suggest?mode=new|carryover&areaId=&date=&repUserId=
export async function suggest(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const data = await service.suggest(ctx, { mode: req.query.mode, areaId: req.query.areaId, date: req.query.date });
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// GET /api/daily-plans/repeats?from=&to=&repUserId=
export async function repeats(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const data = await service.repeatsReport(ctx, { from: req.query.from, to: req.query.to });
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// GET /api/daily-plans/postpone-stats?from=&to=&repUserId=
export async function postponeStats(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const data = await service.postponeStats(ctx, { from: req.query.from, to: req.query.to });
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// POST /api/daily-plans/:id/comments  { content, repUserId? }
export async function addComment(req, res, next) {
  try {
    const ctx = await service.resolveRepContext(req);
    const c = await service.addComment(ctx, parseInt(req.params.id), req.body?.content);
    res.status(201).json({ success: true, data: c });
  } catch (err) { next(err); }
}

// GET /api/daily-plans/settings
export async function getSettings(req, res, next) {
  try {
    const data = await service.getSettings(req.user.id);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// PUT /api/daily-plans/settings
export async function putSettings(req, res, next) {
  try {
    const data = await service.putSettings(req.user.id, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}
