import prisma from '../../lib/prisma.js';
import { callGeminiSmart } from '../ai-assistant/ai-assistant.controller.js';

// ─── Helpers ────────────────────────────────────────────────
function norm(s = '') {
  return String(s).trim()
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildFileFilter(fileIds) {
  if (!fileIds) return {};
  const ids = String(fileIds).split(',').map(Number).filter(Boolean);
  if (!ids.length) return {};
  return ids.length === 1 ? { uploadedFileId: ids[0] } : { uploadedFileId: { in: ids } };
}

function toIQD(value, uploadedFile) {
  if (!uploadedFile) return value || 0;
  const rate = uploadedFile.exchangeRate || 1500;
  const mode = uploadedFile.currencyMode || uploadedFile.detectedCurrency || 'IQD';
  return mode === 'USD' ? (value || 0) * rate : (value || 0);
}

function inc(map, key, qty, value, isReturn) {
  if (!map.has(key)) map.set(key, { name: key, salesQty: 0, salesValue: 0, returnsQty: 0, returnsValue: 0, orders: 0 });
  const o = map.get(key);
  if (isReturn) { o.returnsQty += qty; o.returnsValue += value; }
  else          { o.salesQty   += qty; o.salesValue   += value; o.orders++; }
}

// Convert breakdown Map → sorted plain array
function toArr(map) {
  return [...map.values()]
    .map(o => ({ ...o, netQty: o.salesQty - o.returnsQty, netValue: o.salesValue - o.returnsValue }))
    .sort((a, b) => b.netValue - a.netValue);
}

const FEEDBACK_AR = {
  writing:        'يكتب',
  stocked:        'يحتفظ بالمخزون',
  interested:     'مهتم',
  not_interested: 'غير مهتم',
  unavailable:    'غير متوفر',
  pending:        'بانتظار',
};

// ─── GET /api/item-analysis/items — list items for selector ─
export async function listItems(req, res, next) {
  try {
    const userId = req.user.id;
    const search = req.query.search ? norm(req.query.search) : null;
    const fileIds = req.query.fileIds || null;

    // Use items that actually appear in user's sales (limited by file selection)
    const sales = await prisma.sale.findMany({
      where: { userId, ...buildFileFilter(fileIds) },
      select: { itemId: true },
      distinct: ['itemId'],
    });
    const itemIds = sales.map(s => s.itemId).filter(Boolean);
    if (!itemIds.length) return res.json({ items: [] });

    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, name: true, scientificName: true, dosage: true, form: true, companyId: true },
      orderBy: { name: 'asc' },
    });
    const filtered = search
      ? items.filter(i => norm(i.name).includes(search) || norm(i.scientificName || '').includes(search))
      : items;
    res.json({ items: filtered });
  } catch (e) { next(e); }
}

// ─── GET /api/item-analysis/:itemId/reps — scientific reps linked to manager ─
export async function listReps(req, res, next) {
  try {
    const userId = req.user.id;
    const itemId = Number(req.params.itemId);
    const fileIds = req.query.fileIds || null;
    const days = Math.max(7, Math.min(730, Number(req.query.days) || 180));
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // ── 1. Get manager's company IDs ──────────────────────────────────────
    const companyAssignments = await prisma.userCompanyAssignment.findMany({
      where: { userId }, select: { companyId: true },
    });
    const companyIds = companyAssignments.map(a => a.companyId);

    // ── 2. ALL rep users in same companies (no hierarchy restriction) ─────
    const repUsersRaw = companyIds.length > 0
      ? await prisma.user.findMany({
          where: {
            role: { in: ['scientific_rep', 'team_leader', 'commercial_rep'] },
            isActive: true,
            companyAssignments: { some: { companyId: { in: companyIds } } },
          },
          select: { id: true, displayName: true, username: true, linkedRepId: true },
        })
      : [];

    // ── 3. Find-or-create ScientificRepresentative for each system user ───
    // (same pattern as scientific-reps.service.js so no rep is silently skipped)
    const systemRepIds = new Set();
    const allRepRecords = []; // { repId, name }
    for (const u of repUsersRaw) {
      let repId = u.linkedRepId;
      if (!repId) {
        let rep = await prisma.scientificRepresentative.findFirst({
          where: { userId: u.id }, select: { id: true },
        });
        if (!rep) {
          // Auto-create the record so the rep can appear in the dropdown
          rep = await prisma.scientificRepresentative.create({
            data: { name: u.displayName || u.username, userId: u.id },
          });
          await prisma.user.update({ where: { id: u.id }, data: { linkedRepId: rep.id } });
        }
        repId = rep.id;
      }
      systemRepIds.add(repId);
      allRepRecords.push({ repId, name: u.displayName || u.username });
    }

    // ── 4. Standalone reps (manually added by manager, not system users) ──
    const standaloneReps = await prisma.scientificRepresentative.findMany({
      where: {
        userId,
        isActive: true,
        ...(systemRepIds.size > 0 ? { id: { notIn: [...systemRepIds] } } : {}),
      },
      select: { id: true, name: true },
    });
    for (const r of standaloneReps) allRepRecords.push({ repId: r.id, name: r.name });

    if (!allRepRecords.length) return res.json({ reps: [] });

    // ── 5. Deduplicate by repId ───────────────────────────────────────────
    const seen = new Set();
    const uniqueRecs = allRepRecords.filter(r => !seen.has(r.repId) && seen.add(r.repId));

    // ── 6. Load areas for all reps ────────────────────────────────────────
    const allIds = uniqueRecs.map(r => r.repId);
    const areaRows = await prisma.scientificRepArea.findMany({
      where: { scientificRepId: { in: allIds } },
      select: { scientificRepId: true, areaId: true },
    });
    const areasByRepId = new Map();
    for (const row of areaRows) {
      if (!areasByRepId.has(row.scientificRepId)) areasByRepId.set(row.scientificRepId, []);
      areasByRepId.get(row.scientificRepId).push(row.areaId);
    }

    // ── 7. Sales value/qty per area (for rep-specific sales estimate) ─────
    const salesByAreaRaw = await prisma.sale.groupBy({
      by: ['areaId'],
      where: { userId, itemId, ...buildFileFilter(fileIds), recordType: 'sale' },
      _sum: { totalValue: true, quantity: true },
    });
    const salesValueByArea = new Map(salesByAreaRaw.map(s => [s.areaId, s._sum.totalValue || 0]));
    const salesQtyByArea   = new Map(salesByAreaRaw.map(s => [s.areaId, s._sum.quantity  || 0]));

    // ── 8. Doctor visit counts per rep for this item ──────────────────────
    const drVisits = await prisma.doctorVisit.findMany({
      where: { userId, itemId, visitDate: { gte: since } },
      select: { scientificRepId: true },
    });
    const visitCountById = new Map();
    for (const v of drVisits) {
      if (v.scientificRepId != null)
        visitCountById.set(v.scientificRepId, (visitCountById.get(v.scientificRepId) || 0) + 1);
    }

    // ── 9. Pharmacy visit counts per rep for this item ────────────────────
    const phVisits = await prisma.pharmacyVisit.findMany({
      where: { userId, visitDate: { gte: since }, visitItems: { some: { itemId } } },
      select: { scientificRepId: true },
    }).catch(() => []);
    const pvCountById = new Map();
    for (const v of phVisits) {
      if (v.scientificRepId != null)
        pvCountById.set(v.scientificRepId, (pvCountById.get(v.scientificRepId) || 0) + 1);
    }

    // ── 10. Shape all reps (show ALL — no area filter exclusion) ─────────
    const reps = uniqueRecs
      .map(({ repId, name }) => {
        const repAreaIds = areasByRepId.get(repId) || [];
        const visitsCount         = visitCountById.get(repId) || 0;
        const pharmacyVisitsCount = pvCountById.get(repId)    || 0;
        const areasSalesValue = repAreaIds.reduce((s, aid) => s + (salesValueByArea.get(aid) || 0), 0);
        const areasSalesQty   = repAreaIds.reduce((s, aid) => s + (salesQtyByArea.get(aid)   || 0), 0);
        let source;
        if (areasSalesValue > 0 && (visitsCount > 0 || pharmacyVisitsCount > 0)) source = 'both';
        else if (visitsCount > 0 || pharmacyVisitsCount > 0) source = 'visits';
        else if (areasSalesValue > 0) source = 'area-sales';
        else source = 'none';
        return {
          id: repId, name, repType: 'scientific',
          salesValue: areasSalesValue, salesQty: areasSalesQty,
          visitsCount, pharmacyVisitsCount,
          areaIds: repAreaIds, areasCount: repAreaIds.length,
          source,
        };
      })
      .sort((a, b) =>
        (b.visitsCount + b.pharmacyVisitsCount * 0.5) - (a.visitsCount + a.pharmacyVisitsCount * 0.5) ||
        b.salesValue - a.salesValue ||
        a.name.localeCompare(b.name, 'ar')
      );

    res.json({ reps });
  } catch (e) { next(e); }
}

// ─── GET /api/item-analysis/:itemId — full aggregator ───────
export async function getItemAnalytics(req, res, next) {
  try {
    const userId = req.user.id;
    const itemId = Number(req.params.itemId);
    const fileIds = req.query.fileIds || null;
    const days = Math.max(7, Math.min(730, Number(req.query.days) || 180));
    const repNameRaw = (req.query.repName || '').trim();
    const repName = repNameRaw || null;
    const repNameN = repName ? norm(repName) : null;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // ── 1. Item core data ──────────────────────────────────
    const item = await prisma.item.findFirst({
      where: { id: itemId },
      include: { company: { select: { id: true, name: true } } },
    });
    if (!item) return res.status(404).json({ error: 'الإيتم غير موجود' });

    // ── 1b. Resolve scientific rep (if repName given) ──────
    // Search across ALL reps in this manager's companies (not just direct subordinates)
    let sciRep = null; // { id, areaIds }
    if (repName) {
      // Build full rep pool: system users in same companies + standalone
      const coAssignments = await prisma.userCompanyAssignment.findMany({
        where: { userId }, select: { companyId: true },
      });
      const cIds = coAssignments.map(a => a.companyId);

      let matchedRepId = null;

      if (cIds.length > 0) {
        const repUsersPool = await prisma.user.findMany({
          where: {
            role: { in: ['scientific_rep', 'team_leader', 'commercial_rep'] },
            isActive: true,
            companyAssignments: { some: { companyId: { in: cIds } } },
          },
          select: { id: true, displayName: true, username: true, linkedRepId: true },
        });
        for (const u of repUsersPool) {
          const uName = u.displayName || u.username || '';
          if (norm(uName) === repNameN) {
            matchedRepId = u.linkedRepId;
            if (!matchedRepId) {
              const rep = await prisma.scientificRepresentative.findFirst({
                where: { userId: u.id }, select: { id: true },
              });
              matchedRepId = rep?.id ?? null;
            }
            break;
          }
        }
      }

      // Fallback: check standalone reps
      if (!matchedRepId) {
        const standalone = await prisma.scientificRepresentative.findFirst({
          where: { userId, name: { equals: repName, mode: 'insensitive' } },
          select: { id: true },
        });
        matchedRepId = standalone?.id ?? null;
      }

      if (matchedRepId) {
        const repAreas = await prisma.scientificRepArea.findMany({
          where: { scientificRepId: matchedRepId }, select: { areaId: true },
        });
        sciRep = { id: matchedRepId, areaIds: repAreas.map(a => a.areaId) };
      }
    }

    // ── 2. Sales (filtered by uploadedFileId + userId + itemId) ──
    const salesWhere = { userId, itemId, ...buildFileFilter(fileIds) };
    if (sciRep) {
      // Scientific rep: filter sales by their assigned areas
      if (sciRep.areaIds.length > 0) {
        salesWhere.areaId = sciRep.areaIds.length === 1
          ? sciRep.areaIds[0]
          : { in: sciRep.areaIds };
      } else {
        salesWhere.areaId = -1; // rep has no areas → no sales
      }
    } else if (repName) {
      // Fallback: filter by medical rep name (legacy)
      salesWhere.representative = { name: { equals: repName, mode: 'insensitive' } };
    }
    const sales = await prisma.sale.findMany({
      where: salesWhere,
      select: {
        quantity: true, totalValue: true, saleDate: true, recordType: true,
        area:           { select: { name: true } },
        representative: { select: { name: true } },
        customer:       { select: { name: true } },
        uploadedFile:   { select: { currencyMode: true, exchangeRate: true, detectedCurrency: true } },
        rawData: true,
      },
    });

    const byArea = new Map(), byRep = new Map(), byPharmacy = new Map(), byMonth = new Map();
    let totalSalesQty = 0, totalSalesValue = 0, totalReturnsQty = 0, totalReturnsValue = 0;
    let firstSaleDate = null, lastSaleDate = null;
    const dedup = new Set();

    for (const s of sales) {
      const iqd = toIQD(s.totalValue, s.uploadedFile);
      const isReturn = s.recordType === 'return';

      // Resolve pharmacy
      let pharma = s.customer?.name;
      if (!pharma && s.rawData) {
        try {
          const r = JSON.parse(s.rawData);
          pharma = r.pharmacyName || r.pharmacy || r.customer || r['اسم الصيدلية'] || r['الصيدلية'] || null;
        } catch {}
      }
      pharma = pharma || 'غير محدد';
      const dateKey = s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : '';
      const dedupKey = [norm(pharma), dateKey, s.quantity, s.totalValue, s.recordType || 'sale'].join('|');
      if (dedup.has(dedupKey)) continue;
      dedup.add(dedupKey);

      if (isReturn) { totalReturnsQty += s.quantity; totalReturnsValue += iqd; }
      else {
        totalSalesQty += s.quantity; totalSalesValue += iqd;
        if (!firstSaleDate || new Date(s.saleDate) < new Date(firstSaleDate)) firstSaleDate = s.saleDate;
        if (!lastSaleDate  || new Date(s.saleDate) > new Date(lastSaleDate))  lastSaleDate  = s.saleDate;
      }

      inc(byArea,     s.area?.name           || 'غير محدد', s.quantity, iqd, isReturn);
      inc(byRep,      s.representative?.name || 'غير محدد', s.quantity, iqd, isReturn);
      inc(byPharmacy, pharma,                                s.quantity, iqd, isReturn);

      const monthKey = dateKey.slice(0, 7); // YYYY-MM
      if (monthKey) inc(byMonth, monthKey, s.quantity, iqd, isReturn);
    }

    // ── 3. Doctor visits for this item (within window) ─────
    const dvWhere = { userId, itemId, visitDate: { gte: since } };
    if (sciRep) {
      dvWhere.scientificRepId = sciRep.id; // exact ID match
    } else if (repName) {
      dvWhere.scientificRep = { name: { equals: repName, mode: 'insensitive' } };
    }
    const doctorVisits = await prisma.doctorVisit.findMany({
      where: dvWhere,
      select: {
        visitDate: true, feedback: true, notes: true, isDoubleVisit: true,
        doctor:        { select: { id: true, name: true, specialty: true, area: { select: { name: true } } } },
        scientificRep: { select: { id: true, name: true } },
      },
      orderBy: { visitDate: 'desc' },
      take: 500,
    });
    const feedbackCounts = {};
    const topDoctors = new Map();
    const topVisitReps = new Map();
    const notesSamples = [];
    for (const v of doctorVisits) {
      const fb = v.feedback || 'pending';
      feedbackCounts[fb] = (feedbackCounts[fb] || 0) + 1;
      const dName = v.doctor?.name || 'غير محدد';
      if (!topDoctors.has(dName)) topDoctors.set(dName, {
        name: dName, specialty: v.doctor?.specialty || '', area: v.doctor?.area?.name || '',
        visits: 0, feedbackSummary: {}, lastVisit: null,
      });
      const d = topDoctors.get(dName);
      d.visits++;
      d.feedbackSummary[fb] = (d.feedbackSummary[fb] || 0) + 1;
      if (!d.lastVisit || v.visitDate > d.lastVisit) d.lastVisit = v.visitDate;
      const rName = v.scientificRep?.name;
      if (rName) {
        topVisitReps.set(rName, (topVisitReps.get(rName) || 0) + 1);
      }
      if (v.notes && v.notes.trim() && notesSamples.length < 25) {
        notesSamples.push({
          doctor: dName,
          feedback: FEEDBACK_AR[fb] || fb,
          date: v.visitDate,
          notes: v.notes.trim().slice(0, 300),
        });
      }
    }

    // ── 4. Pharmacy visits for this item ───────────────────
    const pvWhere = { itemId, pharmacyVisit: { userId, visitDate: { gte: since } } };
    if (sciRep) {
      pvWhere.pharmacyVisit = { ...pvWhere.pharmacyVisit, scientificRepId: sciRep.id };
    } else if (repName) {
      pvWhere.pharmacyVisit = {
        ...pvWhere.pharmacyVisit,
        scientificRep: { name: { equals: repName, mode: 'insensitive' } },
      };
    }
    const pharmacyVisitItems = await prisma.pharmacyVisitItem.findMany({
      where: pvWhere,
      select: {
        notes: true, itemName: true,
        pharmacyVisit: {
          select: {
            pharmacyName: true, visitDate: true, notes: true,
            area: { select: { name: true } },
            scientificRep: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const pharmacyVisitsAgg = new Map();
    const pharmacyVisitNotes = [];
    for (const pv of pharmacyVisitItems) {
      const name = pv.pharmacyVisit?.pharmacyName || 'غير محدد';
      if (!pharmacyVisitsAgg.has(name)) pharmacyVisitsAgg.set(name, {
        name, area: pv.pharmacyVisit?.area?.name || '', visits: 0, lastVisit: null,
      });
      const o = pharmacyVisitsAgg.get(name);
      o.visits++;
      const vd = pv.pharmacyVisit?.visitDate;
      if (vd && (!o.lastVisit || vd > o.lastVisit)) o.lastVisit = vd;
      const noteText = pv.notes || pv.pharmacyVisit?.notes;
      if (noteText && pharmacyVisitNotes.length < 15) {
        pharmacyVisitNotes.push({ pharmacy: name, date: vd, notes: String(noteText).slice(0, 300) });
      }
    }

    // ── 5. Competitor benchmark — top 5 items in same company ──
    let competitors = [];
    if (item.companyId) {
      const sibSales = await prisma.sale.groupBy({
        by: ['itemId'],
        where: {
          userId,
          item: { companyId: item.companyId },
          recordType: 'sale',
          ...buildFileFilter(fileIds),
        },
        _sum: { quantity: true, totalValue: true },
      });
      const top = sibSales
        .map(s => ({ itemId: s.itemId, qty: s._sum.quantity || 0, value: s._sum.totalValue || 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 6);
      const sibItems = await prisma.item.findMany({
        where: { id: { in: top.map(t => t.itemId) } },
        select: { id: true, name: true, scientificName: true },
      });
      const byId = new Map(sibItems.map(i => [i.id, i]));
      competitors = top.map(t => ({
        itemId: t.itemId,
        name: byId.get(t.itemId)?.name || '',
        scientificName: byId.get(t.itemId)?.scientificName || '',
        qty: t.qty,
        value: t.value,
        isCurrent: t.itemId === itemId,
      }));
    }

    // ── 6. Per-rep diagnostic block (when repName given) ────
    let repDiagnostic = null;
    if (repName) {
      // doctors visited stats
      const doctorVisitsByDoc = new Map();
      for (const v of doctorVisits) {
        const d = v.doctor?.name || 'غير محدد';
        doctorVisitsByDoc.set(d, (doctorVisitsByDoc.get(d) || 0) + 1);
      }
      const counts = [...doctorVisitsByDoc.values()];
      const singleVisitDoctors  = counts.filter(c => c === 1).length;
      const repeatedVisitDoctors = counts.filter(c => c >= 2).length;
      const doctorsVisited = doctorVisitsByDoc.size;
      const avgVisitsPerDoctor = doctorsVisited ? (doctorVisits.length / doctorsVisited) : 0;

      // monthly mismatch: sales vs visits
      const salesMonths = new Set();
      for (const s of sales) {
        if (s.recordType === 'return') continue;
        const m = s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 7) : '';
        if (m) salesMonths.add(m);
      }
      const visitMonths = new Set();
      for (const v of doctorVisits) {
        const m = v.visitDate ? new Date(v.visitDate).toISOString().slice(0, 7) : '';
        if (m) visitMonths.add(m);
      }
      const salesNoVisits = [...salesMonths].filter(m => !visitMonths.has(m)).length;
      const visitsNoSales = [...visitMonths].filter(m => !salesMonths.has(m)).length;

      // pharmacy visits count for this rep
      const pharmacyVisitsCount = pharmacyVisitItems.length;
      const doctorPharmacyRatio = pharmacyVisitsCount > 0
        ? doctorVisits.length / pharmacyVisitsCount
        : (doctorVisits.length > 0 ? 999 : 0);

      // feedback breakdown for this rep
      const positiveFeedback = (feedbackCounts.writing || 0) + (feedbackCounts.interested || 0) + (feedbackCounts.stocked || 0);
      const negativeFeedback = (feedbackCounts.not_interested || 0) + (feedbackCounts.unavailable || 0);

      // sales totals for this rep
      const repSalesValue = totalSalesValue;
      const repReturnsValue = totalReturnsValue;
      const repNetValue = repSalesValue - repReturnsValue;

      // plan coverage: scientific reps' monthly plans
      let planCoverage = { totalPlans: 0, plansWithItem: 0, coveragePct: 0 };
      try {
        const planWhere = { userId };
        if (sciRep) {
          planWhere.scientificRepId = sciRep.id;
        } else {
          planWhere.scientificRep = { name: { equals: repName, mode: 'insensitive' } };
        }
        const plans = await prisma.monthlyPlan.findMany({
          where: planWhere,
          select: {
            id: true, month: true, year: true,
            entries: { select: { targetItems: { where: { itemId }, select: { id: true } } } },
          },
        });
        const total = plans.length;
        const withItem = plans.filter(p => p.entries.some(e => e.targetItems.length > 0)).length;
        planCoverage = {
          totalPlans: total,
          plansWithItem: withItem,
          coveragePct: total > 0 ? Math.round((withItem / total) * 100) : 0,
        };
      } catch (err) {
        console.warn('[item-analysis] plan coverage failed:', err?.message);
      }

      // Build human-readable signals (rule-based diagnostic hints for AI)
      const signals = [];
      if (doctorVisits.length < 5) signals.push('قلة الكولات الطبية (أقل من 5 زيارات)');
      if (planCoverage.totalPlans > 0 && planCoverage.plansWithItem === 0)
        signals.push('الإيتم غير مدرج في أي بلان شهري لهذا المندوب');
      if (doctorsVisited > 0 && singleVisitDoctors > repeatedVisitDoctors * 2)
        signals.push('ضعف المتابعة: غالبية الأطباء بزيارة وحيدة بدون زيارة ثانية');
      if (positiveFeedback >= 3 && repNetValue < 100)
        signals.push('فيدباك إيجابي متعدد لكن المبيعات شبه معدومة → مشكلة من جهة الصيدلية أو ضعف إغلاق المبيع');
      if (repSalesValue > 0 && doctorVisits.length === 0)
        signals.push('مبيعات بدون أي كولات طبية → اعتماد كامل على الصيدليات (ضعف الكول العلمي)');
      if (pharmacyVisitsCount > 0 && doctorPharmacyRatio < 0.3)
        signals.push('تركيز على الصيدليات أكثر من الأطباء بكثير (نسبة كولات الأطباء/الصيدليات منخفضة)');
      if (visitsNoSales >= 2 && salesMonths.size === 0)
        signals.push('زيارات بدون أي مبيعات على الإطلاق');

      repDiagnostic = {
        repName,
        repType: sciRep ? 'scientific' : 'medical',
        sciRepId: sciRep?.id || null,
        repAreaIds: sciRep?.areaIds || [],
        callCount: doctorVisits.length,
        pharmacyVisitsCount,
        doctorsVisited,
        singleVisitDoctors,
        repeatedVisitDoctors,
        avgVisitsPerDoctor: Math.round(avgVisitsPerDoctor * 10) / 10,
        positiveFeedback,
        negativeFeedback,
        feedbackCounts,
        salesNoVisits,
        visitsNoSales,
        doctorPharmacyRatio: Math.round(doctorPharmacyRatio * 100) / 100,
        planCoverage,
        salesValue: repSalesValue,
        returnsValue: repReturnsValue,
        netValue: repNetValue,
        signals,
      };
    }

    res.json({
      item: {
        id: item.id, name: item.name, scientificName: item.scientificName,
        dosage: item.dosage, form: item.form, price: item.price,
        scientificMessage: item.scientificMessage, imageUrl: item.imageUrl,
        company: item.company ? { id: item.company.id, name: item.company.name } : null,
      },
      windowDays: days,
      repName: repName || null,
      repDiagnostic,
      overview: {
        salesQty: totalSalesQty,
        salesValue: totalSalesValue,
        returnsQty: totalReturnsQty,
        returnsValue: totalReturnsValue,
        netQty: totalSalesQty - totalReturnsQty,
        netValue: totalSalesValue - totalReturnsValue,
        ordersCount: sales.filter(s => s.recordType !== 'return').length,
        areasCount: byArea.size,
        repsCount: byRep.size,
        pharmaciesCount: byPharmacy.size,
        doctorsVisitedCount: topDoctors.size,
        totalDoctorVisits: doctorVisits.length,
        totalPharmacyVisits: pharmacyVisitItems.length,
        firstSaleDate, lastSaleDate,
      },
      salesByArea:  toArr(byArea).slice(0, 25),
      salesByRep:   toArr(byRep).slice(0, 25),
      salesByMonth: toArr(byMonth).sort((a, b) => a.name.localeCompare(b.name)),
      topPharmacies: toArr(byPharmacy).slice(0, 15),
      doctorVisits: {
        total: doctorVisits.length,
        feedbackCounts,
        feedbackLabels: FEEDBACK_AR,
        topDoctors: [...topDoctors.values()].sort((a, b) => b.visits - a.visits).slice(0, 15),
        topReps: [...topVisitReps.entries()].map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count).slice(0, 10),
        notesSamples,
      },
      pharmacyVisits: {
        total: pharmacyVisitItems.length,
        topPharmacies: [...pharmacyVisitsAgg.values()].sort((a, b) => b.visits - a.visits).slice(0, 15),
        notesSamples: pharmacyVisitNotes,
      },
      competitors,
    });
  } catch (e) { next(e); }
}

// ─── POST /api/item-analysis/:itemId/ai-insight ─────────────
export async function getAIInsight(req, res, next) {
  try {
    const userId = req.user.id;
    const itemId = Number(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const { fileIds = null, days = 180, repName = null } = req.body || {};

    // Re-run aggregator inline to get fresh data
    req.params.itemId = itemId;
    req.query.fileIds = fileIds || '';
    req.query.days = days;
    if (repName) req.query.repName = repName;

    // Capture aggregator output without sending response
    let aggregated = null;
    const fakeRes = {
      status() { return this; },
      json(d) { aggregated = d; return this; },
    };
    await getItemAnalytics({ user: { id: userId }, params: req.params, query: req.query }, fakeRes, next);
    if (!aggregated || aggregated.error) {
      return res.status(404).json({ error: aggregated?.error || 'فشل تجميع البيانات' });
    }

    // Slim down aggregated for prompt
    const slim = {
      item: aggregated.item,
      windowDays: aggregated.windowDays,
      repName: aggregated.repName,
      overview: aggregated.overview,
      topAreas: aggregated.salesByArea.slice(0, 10),
      bottomAreas: [...aggregated.salesByArea].reverse().slice(0, 5),
      topReps: aggregated.salesByRep.slice(0, 10),
      bottomReps: [...aggregated.salesByRep].reverse().slice(0, 5),
      monthlyTrend: aggregated.salesByMonth.slice(-12),
      topPharmacies: aggregated.topPharmacies.slice(0, 10),
      doctorVisits: {
        total: aggregated.doctorVisits.total,
        feedbackCounts: aggregated.doctorVisits.feedbackCounts,
        topDoctors: aggregated.doctorVisits.topDoctors.slice(0, 10),
        notesSamples: aggregated.doctorVisits.notesSamples.slice(0, 15),
      },
      pharmacyVisits: aggregated.pharmacyVisits,
      competitors: aggregated.competitors,
      repDiagnostic: aggregated.repDiagnostic,
    };

    const it = slim.item;
    const hasRep = !!slim.repName && !!slim.repDiagnostic;

    const repBlock = hasRep ? `

# ⚠️ تشخيص خاص بالمندوب: ${slim.repName}
البيانات التالية تخص هذا المندوب فقط (مفلترة):
${JSON.stringify(slim.repDiagnostic, null, 2)}

## القواعد التشخيصية الواجب تطبيقها
طبّق القواعد التالية بحرفية على بيانات هذا المندوب أعلاه:
1. إذا كان \`callCount < 5\` → السبب الرئيسي قلة الكولات → اقترح زيادة الكولات.
2. إذا كان \`planCoverage.plansWithItem == 0\` بينما \`planCoverage.totalPlans > 0\` → الإيتم خارج بلانات هذا المندوب → اقترح إدراجه في البلان القادم.
3. إذا كان \`singleVisitDoctors > repeatedVisitDoctors * 2\` → ضعف المتابعة بعد الزيارة الأولى → اقترح خطة زيارة ثانية لكل طبيب خلال أسبوعين.
4. إذا كان \`positiveFeedback >= 3\` ولكن \`netValue\` منخفض → فيدباك إيجابي لكن لا توجد طلبيات → المشكلة من جهة الصيدلية (عدم توفر، عدم طلب، مشكلة سعر) → اقترح جولة صيدليات مع الأطباء.
5. إذا كان \`salesValue > 0\` ولكن \`callCount == 0\` → مبيعات بدون كولات → اعتماد على الصيدلي وضعف الكول العلمي → اقترح تدريب على المحادثة العلمية.
6. إذا كان \`doctorPharmacyRatio < 0.3\` → تركيز خاطئ على الصيدليات → اقترح إعادة توازن الجدول.
7. إذا كان \`visitsNoSales >= 2\` ولكن \`salesMonths == 0\` → زيارات بدون نتائج → اقترح مراجعة الرسالة العلمية وأسلوب الـClosing.

## إشارات تلقائية مستخلصة من البيانات
${slim.repDiagnostic.signals.length > 0 ? slim.repDiagnostic.signals.map(s => `- ${s}`).join('\n') : '- لا توجد إشارات تلقائية واضحة، حلل البيانات يدوياً'}
` : '';

    const prompt = `أنت محلل مبيعات أدوية خبير ومستشار طبي علمي عميق. حلل أداء الإيتم التالي تحليلاً شاملاً ومنظماً بالعربية الفصحى.

# بيانات الإيتم
- الاسم التجاري: ${it.name}
- الاسم العلمي: ${it.scientificName || 'غير محدد'}
- الجرعة: ${it.dosage || 'غير محدد'}
- الشكل الدوائي: ${it.form || 'غير محدد'}
- السعر: ${it.price ?? 'غير محدد'}
- الشركة: ${it.company?.name || 'غير محدد'}
- الرسالة العلمية المسجّلة: ${it.scientificMessage || 'لا توجد'}

# نافذة التحليل
آخر ${slim.windowDays} يوم.${hasRep ? ` — التحليل مفلتر على المندوب: ${slim.repName}` : ' — التحليل عام لجميع المندوبين'}

# ملخص الأداء${hasRep ? ' (للمندوب المحدد)' : ' (الكلي)'}
${JSON.stringify(slim.overview, null, 2)}

# أعلى المناطق مبيعاً
${JSON.stringify(slim.topAreas, null, 2)}

# أضعف المناطق
${JSON.stringify(slim.bottomAreas, null, 2)}

# المندوبون (مرجعي إذا التحليل عام)
${JSON.stringify(slim.topReps, null, 2)}

# التطور الشهري
${JSON.stringify(slim.monthlyTrend, null, 2)}

# الصيدليات
${JSON.stringify(slim.topPharmacies, null, 2)}

# زيارات الأطباء
${JSON.stringify(slim.doctorVisits, null, 2)}

# زيارات الصيدليات
${JSON.stringify(slim.pharmacyVisits, null, 2)}

# منافسون داخل نفس الشركة
${JSON.stringify(slim.competitors, null, 2)}
${repBlock}

# المطلوب
اكتب تقريراً منظماً بصيغة Markdown يحوي الأقسام التالية بالضبط (مع العنوان والإيموجي). لا تكتفِ بالعموميات، اربط كل استنتاج بأرقام محددة من البيانات أعلاه.

## 💊 1. Scientific Drug Profile (الملف العلمي)
Write this section **in English medical terminology**. Use Arabic only in parentheses for critical label terms. Keep all phrases short, factual, and clinically precise. Use the following exact structure (one compact line or 2-3 words per field, no verbose sentences):

**Brand:** [name] | **Generic (الاسم العلمي):** [active ingredient(s)]
**Drug Class (الفئة):** [class] | **Form (الشكل):** [dosage form] | **Strength:** [dosage]
**Mechanism (آلية العمل):** [1 concise sentence — how it works at cellular/molecular level]
**Indications (الاستخدامات):** [comma-separated, 4-6 items max]
**Off-label Uses:** [2-3 items or "Not established"]
**Contraindications (الموانع):** [key contraindications as comma-separated]
**Side Effects — Common (شائعة):** [list] | **Serious (خطيرة):** [list]
**Pregnancy (الحمل):** FDA Cat. [X] — [brief 1-line note] | **Breastfeeding:** [Safe / Avoid / Caution]
**Drug Interactions (تداخلات):** [Top 3-5 as comma-separated]
**Pharmacokinetics:** Onset [X] | T½ [X] | Bioavailability [X%] | Excretion [renal/hepatic]
**Target Population (الفئة المستهدفة):** [Adults / Children / Both] — [key cautions]

## 🩺 2. التخصصات الطبية الأكثر وصفاً
استنتج علمياً + استدل من بيانات الزيارات: ما هي التخصصات التي تصف هذا الدواء عادةً؟ (Cardiologist, GP, Pediatrician, OB-GYN, ...) رتّبها حسب الأهمية.

## 🏆 3. تحليل المنافسة العميق
### أ. منافسون بنفس الاسم العلمي (Generic equivalents)
اذكر أبرز البدائل بنفس المكون الفعّال في السوق العراقي/الإقليمي، مع نقاط التميّز عنها.
### ب. منافسون بفئة علاجية مماثلة (Class competitors)
أدوية مختلفة الاسم العلمي لكن تعطي نفس التأثير العلاجي.
### ج. نقاط القوة والضعف لإيتمنا
قارن صراحةً: ما الذي يجعل إيتمنا أفضل/أسوأ من المنافسين؟ السعر، الجرعة، الأعراض، الشكل، الشركة، الـbioavailability.

## 📊 4. انتشار السوق
بناءً على بيانات الزيارات والمبيعات: ما تقديرك لانتشار هذا الدواء في السوق؟ ما حصته السوقية النسبية؟ هل هو في طور النمو أم التراجع؟

## 🔍 5. التشخيص العام لضعف المبيع
حلل الأسباب الجذرية (ليس فقط الأرقام): مقارنة المناطق، الموسمية، علاقة الفيدباك بالمبيعات، فجوات التوزيع.
${hasRep ? `
## 👤 6. التشخيص الخاص بالمندوب: ${slim.repName}
طبّق القواعد التشخيصية السبع المذكورة أعلاه على بيانات هذا المندوب. لكل قاعدة تنطبق:
- **اذكر الرقم المحدد** من البيانات (مثلاً: "callCount=3 < 5 → قلة كولات واضحة")
- **حدد السبب الجذري**
- **اقترح إجراءً تصحيحياً محدداً** قابلاً للقياس

لا تذكر القواعد التي لا تنطبق. ركّز على الأكثر تأثيراً.
` : ''}
## 🎯 ${hasRep ? '7' : '6'}. اقتراحات عملية ${hasRep ? `للمندوب ${slim.repName}` : 'لفريق المبيعات'} (5-7 نقاط مرقّمة)
رسائل علمية محددة لكل تخصص، استراتيجيات زيارة، التعامل مع الاعتراضات الشائعة، أطباء وصيدليات تستحق التركيز.

## 📅 ${hasRep ? '8' : '7'}. خطة عمل 30 يوم تنفيذية
جدول بأربعة أعمدة | الأسبوع | الإجراء | المخرج المتوقع | المؤشر |
خطة مرتبطة مباشرةً بالتشخيص أعلاه. ${hasRep ? 'خاصة بهذا المندوب.' : 'موجّهة للفريق ككل.'}

# قواعد عامة
- استشهد بأرقام محددة في كل استنتاج
- تجنّب العموميات والكلام الإنشائي
- إذا كانت بيانات معيّنة غير متوفرة، قل ذلك صراحةً بدلاً من اختلاق أرقام
- المعلومات العلمية يجب أن تكون دقيقة طبياً ومستندة إلى مصادر معروفة
- في قسم التشخيص الخاص بالمندوب، طبّق القواعد بحرفية ولا تخترع قواعد جديدة`;

    let insight;
    try {
      insight = await callGeminiSmart([{ text: prompt }]);
    } catch (err) {
      console.error('[item-analysis] Gemini failed:', err?.message);
      return res.status(503).json({ error: 'خدمة الذكاء الاصطناعي غير متوفرة حالياً. الرجاء المحاولة لاحقاً.' });
    }

    res.json({
      itemId,
      itemName: it.name,
      repName: slim.repName || null,
      insight,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
}

// ─── GET /api/item-analysis/:itemId/market-prices ─────────────
// Returns drug price data from all active drug_price surveys that match this item's name
export async function getMarketPrices(req, res, next) {
  try {
    const itemId = Number(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'itemId required' });

    // Get the item name
    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { name: true, scientificName: true } });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const normalizedName = item.name.trim().toLowerCase();

    // Find all active drug_prices surveys
    const surveys = await prisma.masterSurvey.findMany({
      where: { surveyType: 'drug_prices', isActive: true },
      select: { id: true, name: true },
    });

    if (!surveys.length) return res.json({ data: [], surveyCount: 0 });

    const surveyIds = surveys.map(s => s.id);
    const surveyMap = Object.fromEntries(surveys.map(s => [s.id, s.name]));

    // Get all entries from those surveys where brandName loosely matches item name
    // We fetch all and filter in JS for flexibility (fuzzy match)
    const allEntries = await prisma.drugPriceSurveyEntry.findMany({
      where: { surveyId: { in: surveyIds } },
      orderBy: [{ brandName: 'asc' }, { company: 'asc' }],
    });

    // Fuzzy match: include if item name contains entry brand OR entry brand contains item name
    // Or if item scientificName matches
    const sciName = item.scientificName?.trim().toLowerCase() || '';
    const matched = allEntries.filter(e => {
      const bn = e.brandName.trim().toLowerCase();
      return (
        bn.includes(normalizedName) ||
        normalizedName.includes(bn) ||
        (sciName && (bn.includes(sciName) || sciName.includes(bn)))
      );
    });

    const data = matched.map(e => ({
      ...e,
      surveyName: surveyMap[e.surveyId] || '',
    }));

    res.json({ data, surveyCount: surveys.length });
  } catch (e) { next(e); }
}
