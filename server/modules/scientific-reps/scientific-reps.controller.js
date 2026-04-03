import * as svc from './scientific-reps.service.js';

/** Parse fileIds from query string: '1,2,3' → [1,2,3], '5' → [5], null → null */
const parseFileIds = (raw) => {
  if (!raw) return null;
  const ids = String(raw).split(',').map(Number).filter(n => n > 0);
  return ids.length > 0 ? ids : null;
};

export async function createRep(req, res, next) {
  try {
    const rep = await svc.create({ ...req.body, userId: req.user?.id ?? null }, req.user);
    res.status(201).json({ success: true, data: rep });
  } catch (err) { next(err); }
}

export async function listReps(req, res, next) {
  try {
    const reps = await svc.list({}, req.user ?? null);
    res.json({ success: true, data: reps, total: reps.length });
  } catch (err) { next(err); }
}

export async function getRep(req, res, next) {
  try {
    const rep = await svc.getById(+req.params.id);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

export async function updateRep(req, res, next) {
  try {
    const rep = await svc.update(+req.params.id, req.body);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

export async function deleteRep(req, res, next) {
  try {
    await svc.remove(+req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
}

export async function assignAreas(req, res, next) {
  try {
    const names = (req.body.areaNames || []).map(String).filter(Boolean);
    const rep = await svc.assignAreasByName(+req.params.id, names, req.user?.id ?? null);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

export async function assignItems(req, res, next) {
  try {
    const names = (req.body.itemNames || []).map(String).filter(Boolean);
    const rep = await svc.assignItemsByName(+req.params.id, names, req.user?.id ?? null);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

export async function assignCompanies(req, res, next) {
  try {
    const ids = (req.body.companyIds || []).map(Number).filter(Boolean);
    const rep = await svc.assignCompanies(+req.params.id, ids);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

export async function assignCommercialReps(req, res, next) {
  try {
    const ids = (req.body.commercialRepIds || []).map(Number).filter(Boolean);
    const rep = await svc.assignCommercialReps(+req.params.id, ids);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

export async function getRepReport(req, res, next) {
  try {
    const id = +req.params.id;
    const query = {
      startDate:  req.query.startDate  || undefined,
      endDate:    req.query.endDate    || undefined,
      // Support fileIds=1,2,3 (multi) or fileId=1 (legacy)
      fileIds:    parseFileIds(req.query.fileIds || req.query.fileId),
      recordType: req.query.recordType || null,
    };
    const report = await svc.getReport(id, query);
    res.json({ success: true, data: report });
  } catch (err) { next(err); }
}
