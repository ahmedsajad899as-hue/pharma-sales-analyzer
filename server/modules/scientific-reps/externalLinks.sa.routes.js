// /api/sa/rep-external-links — «ربط الأسماء الخارجية»: لكل مندوب، هل هو مربوط باسم في
// دوفايد وباسم في ميركاتو، مع الربط اليدوي وحذفه (lib/externalRepNames.js).
// الربط يُكتب في SciRepNameLink نفسه الذي تكتبه نافذة مطابقة الأسماء، باسم حساب
// المندوب نفسه — فيقع داخل نطاق زملائه (expandOwnerIdsByCompany) ويسري على استيراد
// الزيارات ونسبة مبيعات ميركاتو.
import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import { externalLinksForReps, loadExternalContext, sourceSummary, invalidateExternalNames } from '../../lib/externalRepNames.js';
import { normalizeRepName } from '../../lib/repNameMatch.js';
import { saveRepNameLinks } from './scientific-reps.service.js';
import { refreshDofiedRepNames } from '../dofied/dofied.sync.js';

const router = Router();
router.use(requireMasterAdmin);

const REP_ROLES = ['scientific_rep', 'team_leader'];

async function loadRows(repIdsFilter = null) {
  const users = await prisma.user.findMany({
    where: {
      isActive: true, role: { in: REP_ROLES },
      linkedRepId: repIdsFilter ? { in: repIdsFilter } : { not: null },
    },
    select: {
      id: true, username: true, displayName: true, role: true, linkedRepId: true,
      office: { select: { id: true, name: true } },
      linkedRep: { select: { name: true, repKind: true } },
      companyAssignments: { select: { isPrimary: true, company: { select: { name: true } } } },
    },
    orderBy: { id: 'asc' },
  });
  const ctx = await loadExternalContext({ fresh: true });
  const links = await externalLinksForReps(users.map(u => u.linkedRepId), ctx);
  const rows = users.map(u => {
    const primary = u.companyAssignments.find(a => a.isPrimary) ?? u.companyAssignments[0];
    const l = links.get(u.linkedRepId) ?? { dofied: { linked: false, names: [], visits: 0, lastVisit: null }, mercato: { linked: false, names: [] }, other: [] };
    return {
      userId: u.id, repId: u.linkedRepId,
      name: u.displayName?.trim() || u.username, repName: u.linkedRep?.name ?? null,
      role: u.role, isMarketer: u.linkedRep?.repKind === 'pharmacy',
      company: primary?.company?.name ?? null, office: u.office?.name ?? null,
      ...l,
    };
  });
  return { rows, ctx };
}

router.get('/', async (_req, res, next) => {
  try {
    const { rows, ctx } = await loadRows();
    // لكل اسم في المصدر: من مربوط به — لقائمة الاختيار و«أسماء بلا مندوب»
    const holders = { dofied: new Map(), mercato: new Map() };
    for (const r of rows) {
      for (const src of ['dofied', 'mercato']) {
        for (const n of r[src].names) {
          if (!holders[src].has(n.key)) holders[src].set(n.key, []);
          holders[src].get(n.key).push(r.name);
        }
      }
    }
    const pool = (map, src) => [...map.values()]
      .map(e => ({ name: e.name, key: e.key, rows: e.rows ?? null, lastSeenAt: e.lastSeenAt ?? null, linkedTo: holders[src].get(e.key) ?? [] }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    res.json({
      success: true,
      data: { rows, dofiedNames: pool(ctx.dofied, 'dofied'), mercatoNames: pool(ctx.mercato, 'mercato'), sources: sourceSummary(ctx) },
    });
  } catch (e) { next(e); }
});

// POST /link { repId, name } — ربط اسم (من دوفايد أو ميركاتو أو مكتوب يدوياً) بالمندوب
router.post('/link', async (req, res, next) => {
  try {
    const repId = Number(req.body?.repId);
    const name = String(req.body?.name ?? '').trim();
    if (!Number.isInteger(repId) || !normalizeRepName(name)) return res.status(400).json({ success: false, error: 'اختر المندوب واكتب الاسم' });
    const owner = await prisma.user.findFirst({
      where: { linkedRepId: repId, isActive: true },
      orderBy: [{ role: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (!owner) return res.status(404).json({ success: false, error: 'لا يوجد حساب فعّال لهذا المندوب' });
    await saveRepNameLinks(owner.id, [{ fromName: name, scientificRepId: repId }]);
    invalidateExternalNames();
    const { rows } = await loadRows([repId]);
    res.json({ success: true, data: rows });
  } catch (e) { next(e); }
});

// DELETE /link { repId, key } — فكّ ربط محفوظ (التطابق التام بالاسم نفسه لا يُفكّ)
router.delete('/link', async (req, res, next) => {
  try {
    const repId = Number(req.body?.repId ?? req.query.repId);
    const key = String(req.body?.key ?? req.query.key ?? '');
    if (!Number.isInteger(repId) || !key) return res.status(400).json({ success: false, error: 'طلب ناقص' });
    const r = await prisma.sciRepNameLink.deleteMany({ where: { scientificRepId: repId, fromKey: key } });
    invalidateExternalNames();
    const { rows } = await loadRows([repId]);
    res.json({ success: true, removed: r.count, data: rows });
  } catch (e) { next(e); }
});

// POST /refresh-dofied { days } — تحديث سجلّ أسماء دوفايد من تصدير آخر أيام (دخول واحد لدوفايد)
router.post('/refresh-dofied', async (req, res) => {
  try {
    const r = await refreshDofiedRepNames({ days: req.body?.days });
    res.json({ success: true, data: r, message: `قُرئ ${r.names} اسم مندوب من دوفايد (${r.from} ← ${r.to})` });
  } catch (e) {
    res.status(e?.status || 400).json({ success: false, error: e?.message || 'فشل التحديث' });
  }
});

export default router;
