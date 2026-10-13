// ════════════════════════════════════════════════════════════════════════════
// province-teams.controller.js — واجهة HTTP لفرق المحافظات.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { loadViewer } from './province-teams.access.js';
import * as structure from './province-teams.service.js';
import { resolveCoverageFiles, listCoverageMonths, computeCoverage } from './province-coverage.js';
import * as personal from './personal-sales.service.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';

const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

/** تعارض الايتمات يحمل تفاصيل لا يمرّرها errorHandler العام. */
function sendError(res, next, err) {
  if (err?.code === 'ITEM_CONFLICT') {
    return res.status(409).json({ success: false, code: err.code, message: err.message, conflicts: err.details ?? [] });
  }
  return next(err);
}

// ── GET /api/province-teams/months ─────────────────────────────────────────
export async function months(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    const files = await resolveCoverageFiles(viewer, req.query.fileIds);
    res.json({ success: true, ...(await listCoverageMonths(files.fileIds)), fileSource: files.source });
  } catch (e) { next(e); }
}

// ── GET /api/province-teams/directory ──────────────────────────────────────
// دليل مبسّط: محافظة ← تيم ليدر ← مندوبون ← ايتمات (كمية + قيمة) لزر «الفرق» في خريطة المحافظات.
// مدير الشركة: مندوبو شركاته فقط، والايتمات المقيَّدة بقائمته (UserItemAssignment) — مندوب لا يعمل
// على أي ايتم من ايتماته لا يظهر له أصلاً. القيم بالدولار (كباقي التقارير) والواجهة تحوّلها.
export async function directory(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    const month = String(req.query.month ?? '').trim() || 'all';
    const [teams, files] = await Promise.all([
      structure.loadVisibleTeams(viewer),
      resolveCoverageFiles(viewer, req.query.fileIds),
    ]);
    const coverage = await computeCoverage(teams, { fileIds: files.fileIds, month });

    // null = بلا تقييد. لا يُطبَّق إلا على مدير الشركة ومن بمستواه.
    const allowed = viewer.mode === 'company' ? await resolveEffectiveItemIds(viewer.id) : null;
    const allowedSet = allowed ? new Set(allowed) : null;

    const out = [];
    for (const t of teams) {
      const cov = coverage.get(t.id);
      const repsMap = new Map();
      for (const a of t.assignments) {
        const c = cov.assignments.get(a.id);
        const items = (c?.byItem ?? []).filter(i => !allowedSet || allowedSet.has(i.itemId));
        // المندوب يُعرض لمدير الشركة فقط إن كان يعمل فعلاً على ايتم من ايتماته (حتى بلا مبيع).
        if (allowedSet && !a.itemIds.some(id => allowedSet.has(id))) continue;
        if (!repsMap.has(a.repUserId)) {
          repsMap.set(a.repUserId, { repUserId: a.repUserId, repName: a.repName, repActive: a.repActive, companies: [], net: 0, qty: 0, items: new Map() });
        }
        const r = repsMap.get(a.repUserId);
        if (!r.companies.includes(a.companyName)) r.companies.push(a.companyName);
        for (const i of items) {
          const cur = r.items.get(i.itemId) ?? { itemId: i.itemId, name: i.name, company: a.companyName, net: 0, qty: 0 };
          cur.net += i.net; cur.qty += i.qty;
          r.items.set(i.itemId, cur);
          r.net += i.net; r.qty += i.qty;
        }
      }
      const reps = [...repsMap.values()].map(r => ({
        ...r,
        net: +r.net.toFixed(2),
        items: [...r.items.values()].map(i => ({ ...i, net: +i.net.toFixed(2) })).sort((a, b) => b.net - a.net),
      })).sort((a, b) => b.net - a.net);
      if (!reps.length && viewer.mode === 'company') continue;
      out.push({ id: t.id, provinceId: t.provinceId, provinceName: t.provinceName, leaderName: t.leaderName, reps });
    }

    res.json({ success: true, month, files: { count: files.fileIds.length, currency: files.currency, rate: files.rate }, teams: out });
  } catch (e) { next(e); }
}

// ── GET /api/province-teams/overview ───────────────────────────────────────
export async function overview(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    const month = String(req.query.month ?? '').trim() || 'all';
    const [teams, files] = await Promise.all([
      structure.loadVisibleTeams(viewer, { teamId: toInt(req.query.teamId) }),
      resolveCoverageFiles(viewer, req.query.fileIds),
    ]);
    const coverage = await computeCoverage(teams, { fileIds: files.fileIds, month });

    const repIds = [...new Set(teams.flatMap(t => t.assignments.map(a => a.repUserId)))];
    const [personalMap, pendingRows] = await Promise.all([
      personal.approvedTotals(repIds, { month, rate: files.rate }),
      teams.length
        ? prisma.repPersonalSale.groupBy({ by: ['teamId'], where: { status: 'pending', teamId: { in: teams.map(t => t.id) } }, _count: { _all: true } })
        : [],
    ]);
    const pendingByTeam = new Map(pendingRows.map(r => [r.teamId, r._count._all]));

    const out = teams.map(t => {
      const cov = coverage.get(t.id);
      const fullView = t.assignments.length === t.allAssignments.length && (viewer.mode === 'office' || t.isLeader);

      const repsMap = new Map();
      for (const a of t.assignments) {
        if (!repsMap.has(a.repUserId)) {
          repsMap.set(a.repUserId, { repUserId: a.repUserId, repName: a.repName, repActive: a.repActive, companies: [], totalNet: 0, totalQty: 0, personalUSD: 0 });
        }
        const r = repsMap.get(a.repUserId);
        const c = cov.assignments.get(a.id);
        const p = personalMap.get(`${a.repUserId}|${a.companyId}`) ?? { valueUSD: 0, qty: 0, rows: 0, pharmacies: 0 };
        r.companies.push({
          assignmentId: a.id,
          companyId: a.companyId,
          companyName: a.companyName,
          allItems: a.allItems,
          itemCount: a.itemIds.length,
          explicitItemIds: a.explicitItemIds,
          coverage: c,
          personal: p,
        });
        r.totalNet += c.net; r.totalQty += c.netQty; r.personalUSD += p.valueUSD;
      }
      // جهد شخصي لصنف غير مطابَق بالكتالوج (بلا شركة) — يظهر على المندوب لا على شركة.
      for (const r of repsMap.values()) {
        const loose = personalMap.get(`${r.repUserId}|0`);
        r.personalUnclassified = loose ?? null;
        if (loose && (fullView || r.repUserId === viewer.id)) r.personalUSD += loose.valueUSD;
        r.totalNet = +r.totalNet.toFixed(2); r.personalUSD = +r.personalUSD.toFixed(2);
      }

      let totals = cov.totals;
      if (!fullView) {
        // مدير الشركة/المندوب: الإجمالي = ما يراه فقط، لا رقم المحافظة لكل الشركات.
        const vis = t.assignments.map(a => cov.assignments.get(a.id));
        const sum = (k) => +vis.reduce((s, x) => s + (x?.[k] || 0), 0).toFixed(2);
        totals = {
          salesValue: sum('salesValue'), returnValue: sum('returnValue'), net: sum('net'), netQty: sum('netQty'),
          warehouseNet: sum('warehouseNet'), pharmacyNet: sum('pharmacyNet'), orders: sum('orders'), customers: sum('customers'),
          byItem: [], byArea: [], topCustomers: [],
        };
      }
      const uncovered = viewer.mode === 'office' || t.isLeader
        ? cov.uncovered
        : viewer.mode === 'company' ? cov.uncovered.filter(u => viewer.companyIds.includes(u.companyId)) : [];

      const reps = [...repsMap.values()].sort((a, b) => b.totalNet - a.totalNet);
      return {
        id: t.id,
        provinceId: t.provinceId,
        provinceName: t.provinceName,
        leaderUserId: t.leaderUserId,
        leaderName: t.leaderName,
        notes: t.notes,
        canReview: t.canReview,
        isLeader: t.isLeader,
        fullView,
        companies: [...new Map(t.assignments.map(a => [a.companyId, { id: a.companyId, name: a.companyName }])).values()],
        totals,
        personalUSD: +reps.reduce((s, r) => s + r.personalUSD, 0).toFixed(2),
        reps,
        uncovered,
        overlaps: fullView ? cov.overlaps : [],
        pendingPersonal: t.canReview ? (pendingByTeam.get(t.id) ?? 0) : 0,
      };
    });

    res.json({
      success: true,
      viewer: { id: viewer.id, name: viewer.name, role: viewer.role, mode: viewer.mode, canEditStructure: viewer.canEditStructure, hasOffice: viewer.officeId != null },
      month,
      files: { count: files.fileIds.length, source: files.source, names: files.names, excludedMercato: files.excludedMercato, currency: files.currency, rate: files.rate },
      provinces: viewer.mode === 'office' && viewer.officeId
        ? await prisma.province.findMany({ select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
        : [],
      teams: out,
    });
  } catch (e) { next(e); }
}

// ── الهيكلية ───────────────────────────────────────────────────────────────
export async function options(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    res.json({ success: true, ...(await structure.getOptions(viewer)) });
  } catch (e) { next(e); }
}

export async function companyItems(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    res.json({ success: true, items: await structure.getCompanyItems(viewer, toInt(req.params.id)) });
  } catch (e) { next(e); }
}

export async function createTeam(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    res.status(201).json({ success: true, team: await structure.createTeam(viewer, req.body ?? {}) });
  } catch (e) { next(e); }
}

export async function updateTeam(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    res.json({ success: true, team: await structure.updateTeam(viewer, toInt(req.params.id), req.body ?? {}) });
  } catch (e) { next(e); }
}

export async function archiveTeam(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    await structure.archiveTeam(viewer, toInt(req.params.id));
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function saveAssignment(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    res.json({ success: true, assignment: await structure.saveAssignment(viewer, toInt(req.params.id), req.body ?? {}) });
  } catch (e) { sendError(res, next, e); }
}

export async function removeAssignment(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    await structure.removeAssignment(viewer, toInt(req.params.id));
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── الجهد الشخصي ───────────────────────────────────────────────────────────
export async function repItems(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    const repUserId = viewer.mode === 'rep' ? viewer.id : (toInt(req.query.repUserId) ?? viewer.id);
    res.json({ success: true, ...(await structure.getRepItems(repUserId)) });
  } catch (e) { next(e); }
}

export async function listPersonal(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    const rows = await personal.listPersonalSales(viewer, {
      month: req.query.month || null,
      status: req.query.status || null,
      teamId: toInt(req.query.teamId),
      repUserId: toInt(req.query.repUserId),
    });
    res.json({ success: true, rows });
  } catch (e) { next(e); }
}

export async function createPersonal(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    res.status(201).json({ success: true, ...(await personal.createPersonalSales(viewer, req.body ?? {})) });
  } catch (e) { next(e); }
}

export async function updatePersonal(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    await personal.updatePersonalSale(viewer, toInt(req.params.id), req.body ?? {});
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function reviewPersonal(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    res.json({ success: true, ...(await personal.reviewPersonalSales(viewer, req.body ?? {})) });
  } catch (e) { next(e); }
}

export async function deletePersonal(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    await personal.deletePersonalSale(viewer, toInt(req.params.id));
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function pendingCount(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    res.json({ success: true, ...(await personal.pendingCounts(viewer)) });
  } catch (e) { next(e); }
}
