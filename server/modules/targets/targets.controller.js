import prisma from '../../lib/prisma.js';
import { resolveMyRepId } from '../scientific-reps/scientific-reps.service.js';

// GET /api/targets?repType=scientific&repId=1&month=5&year=2026
export async function getTargets(req, res, next) {
  try {
    const { repType, repId, month, year } = req.query;
    if (!repType || !repId || !month || !year)
      return res.status(400).json({ error: 'repType, repId, month, year required' });

    const targets = await prisma.repItemTarget.findMany({
      where: {
        repType,
        repId: parseInt(repId),
        month: parseInt(month),
        year:  parseInt(year),
      },
      include: { item: { select: { id: true, name: true } } },
      orderBy: { item: { name: 'asc' } },
    });
    res.json({ success: true, data: targets });
  } catch (e) { next(e); }
}

// GET /api/targets/all?repType=scientific&repId=1
// Returns all targets for a rep across all periods
export async function getAllTargetsForRep(req, res, next) {
  try {
    const { repType, repId } = req.query;
    if (!repType || !repId)
      return res.status(400).json({ error: 'repType, repId required' });

    const targets = await prisma.repItemTarget.findMany({
      where: { repType, repId: parseInt(repId) },
      include: { item: { select: { id: true, name: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { item: { name: 'asc' } }],
    });
    res.json({ success: true, data: targets });
  } catch (e) { next(e); }
}

// PUT /api/targets — batch upsert targets for a rep/period
// body: { repType, repId, month, year, targets: [{ itemId, target }] }
export async function upsertTargets(req, res, next) {
  try {
    const { repType, repId, month, year, targets } = req.body;
    if (!repType || !repId || !month || !year || !Array.isArray(targets))
      return res.status(400).json({ error: 'repType, repId, month, year, targets[] required' });

    const rid = parseInt(repId);
    const m   = parseInt(month);
    const y   = parseInt(year);

    const ops = targets.map(t =>
      prisma.repItemTarget.upsert({
        where: {
          repType_repId_itemId_month_year: {
            repType, repId: rid, itemId: parseInt(t.itemId), month: m, year: y,
          },
        },
        create: { repType, repId: rid, itemId: parseInt(t.itemId), month: m, year: y, target: parseFloat(t.target) || 0 },
        update: { target: parseFloat(t.target) || 0 },
      })
    );

    await prisma.$transaction(ops);
    res.json({ success: true });
  } catch (e) { next(e); }
}

// DELETE /api/targets/:id
export async function deleteTarget(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    await prisma.repItemTarget.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// GET /api/targets/mine?month=5&year=2026
// Returns targets for the currently logged-in scientific rep
export async function getMyTargets(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'غير مصرح' });

    // Resolve (and auto-create if missing) the scientific rep linked to this user —
    // without this, a rep's first login before any manager opened the reps list
    // would see an empty target list even though one may already be set for them.
    const repId = await resolveMyRepId(userId);
    if (!repId) return res.json({ success: true, data: [] });

    const now = new Date();
    const month = req.query.month ? parseInt(req.query.month) : now.getMonth() + 1;
    const year  = req.query.year  ? parseInt(req.query.year)  : now.getFullYear();

    const targets = await prisma.repItemTarget.findMany({
      where: { repType: 'scientific', repId, month, year },
      include: { item: { select: { id: true, name: true } } },
      orderBy: { item: { name: 'asc' } },
    });
    res.json({ success: true, data: targets, repId, month, year });
  } catch (e) { next(e); }
}
