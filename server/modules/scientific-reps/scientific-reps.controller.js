import * as svc from './scientific-reps.service.js';

/** Parse fileIds from query string: '1,2,3' → [1,2,3], '5' → [5], null → null */
const parseFileIds = (raw) => {
  if (!raw) return null;
  const ids = String(raw).split(',').map(Number).filter(n => n > 0);
  return ids.length > 0 ? ids : null;
};

export async function createRep(req, res, next) {
  try {
    // managerId = the manager who creates this standalone rep (not userId, which is reserved for the rep's own user account)
    const rep = await svc.create({ ...req.body, managerId: req.user?.id ?? null }, req.user);
    res.status(201).json({ success: true, data: rep });
  } catch (err) { next(err); }
}

export async function listReps(req, res, next) {
  try {
    // ?standalone=1 is sent by ScientificRepsPage (تحليل ملفات المندوبين).
    // In standalone mode, return ONLY manually-created records scoped to this
    // user (userId = user.id) — never mix in SA-managed system users.
    // ?excludeStandalone=1 is sent by TargetsPage: return only system users
    // (created by master/SA, linked to this manager's companies) without
    // appending the manually-created standalone reps.
    const standalone        = req.query.standalone        === '1';
    const excludeStandalone = req.query.excludeStandalone === '1';
    const reps = await svc.list({}, req.user ?? null, { standalone, excludeStandalone });
    res.json({ success: true, data: reps, total: reps.length });
  } catch (err) { next(err); }
}

export async function getRep(req, res, next) {
  try {
    const rep = await svc.getById(+req.params.id);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

// GET /api/scientific-reps/my-areas
// Returns the areas assigned to the currently logged-in scientific rep
export async function getMyAreas(req, res, next) {
  try {
    const areas = await svc.getMyAreas(req.user?.id ?? null);
    res.json({ success: true, data: areas });
  } catch (err) { next(err); }
}

export async function getMyCommercialReps(req, res, next) {
  try {
    const reps = await svc.getMyCommercialReps(req.user?.id ?? null);
    res.json({ success: true, data: reps });
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
  } catch (err) {
    console.error('[deleteRep] error:', err.message, err.code);
    next(err);
  }
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
