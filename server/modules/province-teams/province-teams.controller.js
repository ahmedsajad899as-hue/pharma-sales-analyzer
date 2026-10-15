// ════════════════════════════════════════════════════════════════════════════
// province-teams.controller.js — واجهة HTTP لفرق المحافظات.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { loadViewer } from './province-teams.access.js';
import * as structure from './province-teams.service.js';
import { resolveCoverageFiles, listCoverageMonths, computeCoverage } from './province-coverage.js';
import * as personal from './personal-sales.service.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';
import { buildMonthFilter } from '../../lib/salesMonths.js';
import { loadConditionSalesForReps } from '../../lib/conditionFile.js';

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

    // قائمة «الايتمات» التي عيّنها الماستر أدمن لحساب كل مندوب (null = بلا تقييد).
    // تعيين المندوب في الفريق قد يكون «كل ايتمات الشركة» فيجب تقييده بها.
    const repIds = [...new Set(teams.flatMap(t => t.assignments.map(a => a.repUserId)))];
    const repAllowed = new Map();
    for (const id of repIds) {
      const ids = await resolveEffectiveItemIds(id);
      repAllowed.set(id, ids ? new Set(ids) : null);
    }

    // ── التارگت (كمية لكل ايتم/شهر لحساب المندوب العلمي المرتبط) ──────────────
    const monthPairs = [];
    {
      const parts = month.split('..').map(s => /^(\d{4})-(\d{1,2})$/.exec(s.trim())).filter(Boolean);
      if (parts.length) {
        let y = +parts[0][1], m = +parts[0][2];
        const ly = +(parts[1] ?? parts[0])[1], lm = +(parts[1] ?? parts[0])[2];
        for (let n = 0; n < 60 && (y < ly || (y === ly && m <= lm)); n++) { monthPairs.push({ year: y, month: m }); if (++m > 12) { m = 1; y++; } }
      }
    }
    const repLink = new Map(); // userId → ScientificRepresentative.id
    const targetsByRep = new Map(); // `${userId}|${itemId}` → qty
    if (repIds.length) {
      const [users, repRows] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, linkedRepId: true } }),
        prisma.scientificRepresentative.findMany({ where: { userId: { in: repIds } }, select: { id: true, userId: true } }),
      ]);
      for (const r of repRows) repLink.set(r.userId, r.id);
      for (const u of users) if (u.linkedRepId && !repLink.has(u.id)) repLink.set(u.id, u.linkedRepId);
      if (monthPairs.length && repLink.size) {
        const userOfRep = new Map([...repLink].map(([u, r]) => [r, u]));
        const rows = await prisma.repItemTarget.findMany({
          where: { repType: 'scientific', repId: { in: [...userOfRep.keys()] }, OR: monthPairs.map(p => ({ month: p.month, year: p.year })) },
          select: { repId: true, itemId: true, target: true },
        });
        for (const r of rows) {
          const k = `${userOfRep.get(r.repId)}|${r.itemId}`;
          targetsByRep.set(k, (targetsByRep.get(k) ?? 0) + (r.target || 0));
        }
      }
    }

    // أسماء ايتمات التارگت (قد لا يكون لها مبيع فلا اسم لها في تغطية المحافظة).
    const targetItemNames = new Map();
    if (targetsByRep.size) {
      const ids = [...new Set([...targetsByRep.keys()].map(k => Number(k.split('|')[1])))];
      const rows = await prisma.item.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      for (const r of rows) targetItemNames.set(r.id, r.name);
    }

    // ── مبيع المندوب شخصياً (المعتمد فقط) لكل مندوب×فريق ──────────────────────
    const personalByTeamRep = new Map(); // `${teamId}|${userId}` → rows[]
    if (repIds.length && teams.length) {
      const rows = await prisma.repPersonalSale.findMany({
        where: { repUserId: { in: repIds }, teamId: { in: teams.map(t => t.id) }, status: 'approved', ...buildMonthFilter(month) },
        select: { repUserId: true, teamId: true, itemId: true, itemName: true, quantity: true, totalValue: true, currency: true },
      });
      for (const r of rows) {
        const k = `${r.teamId}|${r.repUserId}`;
        if (!personalByTeamRep.has(k)) personalByTeamRep.set(k, []);
        personalByTeamRep.get(k).push(r);
      }
    }
    const toUSD = (r) => (r.currency === 'USD' ? r.totalValue : r.totalValue / (files.rate || 1470));

    // ── مبيعات «ملف الكوديشن» (بوت/إكسل) لمندوبي المحافظات: تُعدّ مبيعاً شخصياً ──
    const condRepsByUser = new Map();
    for (const t of teams) for (const a of t.assignments) condRepsByUser.set(a.repUserId, { id: a.repUserId, name: a.repName });
    const conditionByRep = await loadConditionSalesForReps([...condRepsByUser.values()], {
      month, officeIds: [...new Set(teams.map(t => t.officeId).filter(Boolean))],
    }).catch(() => new Map());
    const conditionUsed = new Set(); // مندوب في أكثر من فريق: يُحتسب في أول فريق فقط

    const out = [];
    for (const t of teams) {
      const cov = coverage.get(t.id);
      const repsMap = new Map();
      const newItem = (id, name, company) => ({ itemId: id, name, company, net: 0, qty: 0, targetQty: 0, personalQty: 0, personalNet: 0 });
      for (const a of t.assignments) {
        const c = cov.assignments.get(a.id);
        const repSet = repAllowed.get(a.repUserId);
        const okItem = (id) => (!allowedSet || allowedSet.has(id)) && (!repSet || repSet.has(id));
        const items = (c?.byItem ?? []).filter(i => okItem(i.itemId));
        // المندوب يُعرض لمدير الشركة فقط إن كان يعمل فعلاً على ايتم من ايتماته (حتى بلا مبيع).
        if (allowedSet && !a.itemIds.some(id => allowedSet.has(id) && (!repSet || repSet.has(id)))) continue;
        if (!repsMap.has(a.repUserId)) {
          repsMap.set(a.repUserId, { repUserId: a.repUserId, repName: a.repName, repActive: a.repActive, companies: [], net: 0, qty: 0, targetQty: 0, personalQty: 0, personalNet: 0, items: new Map(), a_ids: new Set() });
        }
        const r = repsMap.get(a.repUserId);
        if (!r.companies.includes(a.companyName)) r.companies.push(a.companyName);
        for (const i of items) {
          const cur = r.items.get(i.itemId) ?? newItem(i.itemId, i.name, a.companyName);
          cur.net += i.net; cur.qty += i.qty;
          r.items.set(i.itemId, cur);
          r.net += i.net; r.qty += i.qty;
        }
        // التارگت: ايتمات هذا التعيين التي لها تارگت (حتى بلا مبيع).
        for (const id of a.itemIds) {
          const tq = targetsByRep.get(`${a.repUserId}|${id}`);
          if (!tq || !okItem(id)) continue;
          let cur = r.items.get(id);
          if (!cur) { cur = newItem(id, targetItemNames.get(id) ?? `#${id}`, a.companyName); r.items.set(id, cur); }
          if (!cur.targetCounted) { cur.targetQty = tq; cur.targetCounted = true; r.targetQty += tq; }
        }
      }
      // الجهد الشخصي (مرة واحدة لكل مندوب في هذا الفريق).
      for (const r of repsMap.values()) {
        const nameByItem = new Map();
        for (const a of t.assignments) if (a.repUserId === r.repUserId) for (const id of a.itemIds) nameByItem.set(id, a.companyName);
        for (const p of personalByTeamRep.get(`${t.id}|${r.repUserId}`) ?? []) {
          const repSet = repAllowed.get(r.repUserId);
          if (p.itemId && ((allowedSet && !allowedSet.has(p.itemId)) || (repSet && !repSet.has(p.itemId)))) continue;
          if (!p.itemId && (allowedSet || repAllowed.get(r.repUserId))) continue;
          const key = p.itemId ?? `n:${p.itemName}`;
          let cur = r.items.get(key);
          if (!cur) { cur = newItem(p.itemId ?? null, p.itemName, (p.itemId && nameByItem.get(p.itemId)) || '—'); r.items.set(key, cur); }
          cur.personalQty += p.quantity; cur.personalNet += toUSD(p);
          r.personalQty += p.quantity; r.personalNet += toUSD(p);
        }
        if (!conditionUsed.has(r.repUserId)) {
          conditionUsed.add(r.repUserId);
          const repSet = repAllowed.get(r.repUserId);
          for (const c of conditionByRep.get(r.repUserId) ?? []) {
            if (c.itemId && ((allowedSet && !allowedSet.has(c.itemId)) || (repSet && !repSet.has(c.itemId)))) continue;
            if (!c.itemId && (allowedSet || repSet)) continue;
            const key = c.itemId ?? `n:${c.itemName}`;
            let cur = r.items.get(key);
            if (!cur) { cur = newItem(c.itemId, c.itemName, (c.itemId && nameByItem.get(c.itemId)) || '—'); r.items.set(key, cur); }
            cur.personalQty += c.quantity; cur.personalNet += c.valueUSD;
            r.personalQty += c.quantity; r.personalNet += c.valueUSD;
          }
        }
      }
      const reps = [...repsMap.values()].map(({ a_ids, ...r }) => ({
        ...r,
        net: +r.net.toFixed(2),
        personalNet: +r.personalNet.toFixed(2),
        items: [...r.items.values()].map(({ targetCounted, ...i }) => ({ ...i, net: +i.net.toFixed(2), personalNet: +i.personalNet.toFixed(2) }))
          .sort((a, b) => b.net - a.net || b.targetQty - a.targetQty),
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

    // مبيعات «ملف الكوديشن» (بوت/إكسل) لمندوبي المحافظات تُعدّ مبيعاً شخصياً، موزَّعة
    // على شركات المندوب بحسب ايتمات تعيينه؛ وغير المطابق يذهب لـ«غير مصنّف».
    const condReps = new Map();
    for (const t of teams) for (const a of t.assignments) condReps.set(a.repUserId, { id: a.repUserId, name: a.repName });
    const conditionByRep = await loadConditionSalesForReps([...condReps.values()], {
      month, officeIds: [...new Set(teams.map(t => t.officeId).filter(Boolean))],
    }).catch(() => new Map());
    const conditionDone = new Set(); // مندوب في أكثر من فريق: يُحتسب في أول فريق فقط

    const out = teams.map(t => {
      const cov = coverage.get(t.id);
      const fullView = t.assignments.length === t.allAssignments.length && (viewer.mode === 'office' || t.isLeader);

      const repsMap = new Map();
      const condLeft = new Map(); // repUserId → صفوف كوديشن لم تُوزَّع بعد (هذا الفريق)
      for (const a of t.assignments) {
        if (!repsMap.has(a.repUserId)) {
          repsMap.set(a.repUserId, { repUserId: a.repUserId, repName: a.repName, repActive: a.repActive, companies: [], totalNet: 0, totalQty: 0, personalUSD: 0 });
          if (!conditionDone.has(a.repUserId)) {
            conditionDone.add(a.repUserId);
            condLeft.set(a.repUserId, [...(conditionByRep.get(a.repUserId) ?? [])]);
          }
        }
        const r = repsMap.get(a.repUserId);
        const c = cov.assignments.get(a.id);
        const base = personalMap.get(`${a.repUserId}|${a.companyId}`) ?? { valueUSD: 0, qty: 0, rows: 0, pharmacies: 0 };
        const p = { ...base };
        const left = condLeft.get(a.repUserId);
        if (left?.length) {
          const mine = left.filter(x => x.itemId && a.itemIds.includes(x.itemId));
          if (mine.length) {
            condLeft.set(a.repUserId, left.filter(x => !mine.includes(x)));
            const ph = new Set(mine.map(x => x.pharmacy).filter(Boolean));
            p.valueUSD = +(p.valueUSD + mine.reduce((s2, x) => s2 + x.valueUSD, 0)).toFixed(2);
            p.qty += mine.reduce((s2, x) => s2 + x.quantity, 0);
            p.rows += mine.length;
            p.pharmacies += ph.size; // تقريبي: قد يتكرر اسم مع جهد شخصي معتمد
          }
        }
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
        let loose = personalMap.get(`${r.repUserId}|0`);
        const rest = condLeft.get(r.repUserId) ?? [];
        if (rest.length) {
          loose = { ...(loose ?? { valueUSD: 0, qty: 0, rows: 0, pharmacies: 0 }) };
          loose.valueUSD = +(loose.valueUSD + rest.reduce((s2, x) => s2 + x.valueUSD, 0)).toFixed(2);
          loose.qty += rest.reduce((s2, x) => s2 + x.quantity, 0);
          loose.rows += rest.length;
          loose.pharmacies += new Set(rest.map(x => x.pharmacy).filter(Boolean)).size;
        }
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
