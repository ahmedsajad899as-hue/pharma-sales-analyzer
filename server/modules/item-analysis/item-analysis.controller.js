import prisma from '../../lib/prisma.js';
import { callGeminiSmart } from '../ai-assistant/ai-assistant.controller.js';
import { list as listScientificReps } from '../scientific-reps/scientific-reps.service.js';

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

// ─── Active ingredient fuzzy matching ────────────────────────
// Strips salt forms, dosage, and non-letters to compare ingredient stems.
const SALT_SUFFIX_RX = /\b(as|the|of|and|or|with|free\s*base|anhydrous|sodium|potassium|calcium|magnesium|zinc|hcl|hbr|hydrochloride|hydrobromide|sulfate|sulphate|phosphate|sesquihydrate|monohydrate|dihydrate|trihydrate|maleate|fumarate|tartrate|citrate|succinate|besylate|mesylate|tosylate|acetate|chloride|bromide|nitrate|carbonate|bicarbonate|gluconate|lactate|oxalate|salicylate|stearate|palmitate|hemifumarate|disoproxil|alafenamide|propionate|valerate|benzoate|dipropionate|furoate|pivalate|enanthate|decanoate|undecanoate|cypionate|fumar|maleat|tartrat|citrat|sulf|phosph)\b/g;
function normalizeActive(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\d+(\.\d+)?\s*(mg|mcg|g|ml|iu|%|units?)/g, ' ')
    .replace(SALT_SUFFIX_RX, ' ')
    .replace(/[^a-z]/g, '');
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      m[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
        ? m[i - 1][j - 1]
        : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    }
  }
  return m[b.length][a.length];
}
// Returns true if the two raw ingredient strings refer to the same active substance
// (handles typos, salt suffixes, and one-side multi-ingredient combos).
function isSimilarActive(a, b) {
  const na = normalizeActive(a);
  const nb = normalizeActive(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Substring (must be at least 5 chars) — handles "pantoprazole" inside "pantoprazolesodium"
  const minLen = Math.min(na.length, nb.length);
  if (minLen >= 5 && (na.includes(nb) || nb.includes(na))) return true;
  // Edit distance threshold scales with length: catches common typos like
  //   pantoprazol vs pantaprazol (1) or amoxicillin vs amoxycillin (1)
  const maxLen = Math.max(na.length, nb.length);
  const threshold = maxLen <= 6 ? 1 : maxLen <= 12 ? 2 : 3;
  return levenshtein(na, nb) <= threshold;
}
// Multi-ingredient awareness: split on '+' or '/' or ',' and try any token match
function activeMatchesAny(itemActive, candidate) {
  if (!itemActive || !candidate) return false;
  const itemTokens = String(itemActive).split(/[+/,]+/).map(t => t.trim()).filter(Boolean);
  const candTokens = String(candidate).split(/[+/,]+/).map(t => t.trim()).filter(Boolean);
  for (const a of itemTokens) {
    for (const b of candTokens) {
      if (isSimilarActive(a, b)) return true;
    }
  }
  return false;
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

    // ── 1. Get all reps using the same proven logic as ScientificRepsPage ─
    const baseReps = await listScientificReps({}, req.user);
    if (!baseReps.length) return res.json({ reps: [] });

    // ── 2. Map rep data: id, name, areaIds ───────────────────────────────
    const repData = baseReps.map(r => ({
      repId: r.id,
      name: r.name,
      areaIds: (r.areas || []).map(a => a.id),
    }));

    // ── 3. Sales value/qty per area (for rep-specific sales estimate) ─────
    const salesByAreaRaw = await prisma.sale.groupBy({
      by: ['areaId'],
      where: { userId, itemId, ...buildFileFilter(fileIds), recordType: 'sale' },
      _sum: { totalValue: true, quantity: true },
    });
    const salesValueByArea = new Map(salesByAreaRaw.map(s => [s.areaId, s._sum.totalValue || 0]));
    const salesQtyByArea   = new Map(salesByAreaRaw.map(s => [s.areaId, s._sum.quantity  || 0]));

    // ── 4. Doctor visit counts per rep for this item ──────────────────────
    const drVisits = await prisma.doctorVisit.findMany({
      where: { userId, itemId, visitDate: { gte: since } },
      select: { scientificRepId: true },
    });
    const visitCountById = new Map();
    for (const v of drVisits) {
      if (v.scientificRepId != null)
        visitCountById.set(v.scientificRepId, (visitCountById.get(v.scientificRepId) || 0) + 1);
    }

    // ── 5. Pharmacy visit counts per rep for this item ────────────────────
    const phVisits = await prisma.pharmacyVisit.findMany({
      where: { userId, visitDate: { gte: since }, visitItems: { some: { itemId } } },
      select: { scientificRepId: true },
    }).catch(() => []);
    const pvCountById = new Map();
    for (const v of phVisits) {
      if (v.scientificRepId != null)
        pvCountById.set(v.scientificRepId, (pvCountById.get(v.scientificRepId) || 0) + 1);
    }

    // ── 6. Shape and sort ─────────────────────────────────────────────────
    const reps = repData
      .map(({ repId, name, areaIds }) => {
        const visitsCount         = visitCountById.get(repId) || 0;
        const pharmacyVisitsCount = pvCountById.get(repId)    || 0;
        const areasSalesValue = areaIds.reduce((s, aid) => s + (salesValueByArea.get(aid) || 0), 0);
        const areasSalesQty   = areaIds.reduce((s, aid) => s + (salesQtyByArea.get(aid)   || 0), 0);
        let source;
        if (areasSalesValue > 0 && (visitsCount > 0 || pharmacyVisitsCount > 0)) source = 'both';
        else if (visitsCount > 0 || pharmacyVisitsCount > 0) source = 'visits';
        else if (areasSalesValue > 0) source = 'area-sales';
        else source = 'none';
        return {
          id: repId, name, repType: 'scientific',
          salesValue: areasSalesValue, salesQty: areasSalesQty,
          visitsCount, pharmacyVisitsCount,
          areaIds, areasCount: areaIds.length,
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

    // ── Fetch real survey-based competitor data (drug_prices surveys) ──────
    // Reuses the same matching logic as getMarketPrices to ensure consistency.
    let surveyMarket = { ownProduct: null, competitors: [], surveyCount: 0, matchMode: 'none' };
    try {
      const surveys = await prisma.masterSurvey.findMany({
        where: { surveyType: 'drug_prices', isActive: true },
        select: { id: true, name: true },
      });
      if (surveys.length) {
        const surveyIds = surveys.map(s => s.id);
        const surveyMap = Object.fromEntries(surveys.map(s => [s.id, s.name]));
        const allEntries = await prisma.drugPriceSurveyEntry.findMany({
          where: { surveyId: { in: surveyIds } },
          orderBy: [{ brandName: 'asc' }],
        });
        const aiAnalyses = await prisma.surveyAIAnalysis.findMany({
          where: { surveyId: { in: surveyIds }, status: 'done' },
          select: { surveyId: true, analysisJson: true },
        });
        const entryMap = Object.fromEntries(allEntries.map(e => [e.id, e]));

        const it = aggregated.item;
        const normalName = it.name.trim().toLowerCase().replace(/\s+/g, '');
        const sciName = (it.scientificName || '').trim().toLowerCase();

        if (aiAnalyses.length > 0) {
          const analyzedEntries = [];
          for (const ai of aiAnalyses) {
            try {
              const arr = JSON.parse(ai.analysisJson);
              for (const a of arr) analyzedEntries.push({ ...a, _surveyId: ai.surveyId });
            } catch {}
          }

          let ownEntry = null;
          let ownCompetitorGroup = null;

          for (const a of analyzedEntries) {
            const raw = entryMap[a.entryId];
            if (!raw) continue;
            const bn = raw.brandName.trim().toLowerCase().replace(/\s+/g, '');
            const bnBase = bn.replace(/[\d\.]+\s*(mg|mcg|ml|g|iu|%)/g, '').trim();
            const nameBase = normalName.replace(/[\d\.]+\s*(mg|mcg|ml|g|iu|%)/g, '').trim();
            if (bn === normalName || normalName.includes(bn) || bn.includes(nameBase) || nameBase.includes(bnBase)) {
              ownEntry = a; ownCompetitorGroup = a.competitorGroup; break;
            }
          }
          if (!ownEntry && sciName) {
            for (const a of analyzedEntries) {
              if (activeMatchesAny(sciName, a.activeIngredient)) {
                ownEntry = a; ownCompetitorGroup = a.competitorGroup; break;
              }
            }
          }

          const aiMap = Object.fromEntries(analyzedEntries.map(a => [a.entryId, a]));
          const buildEntry = (e) => {
            const a = aiMap[e.id] || {};
            return {
              brand: e.brandName,
              company: e.company || null,
              scientificName: e.scientificName || null,
              activeIngredient: a.activeIngredient || null,
              drugClass: a.drugClass || null,
              dosage: [a.dosageAmount, a.dosageUnit].filter(Boolean).join('') || null,
              form: a.dosageForm || e.dosageForm || null,
              packaging: e.packaging || null,
              priceOfficeToWholesaler: e.priceOfficeToWholesaler ?? null,
              priceWholesalerToPharmacy: e.priceWholesalerToPharmacy ?? null,
              pricePharmacyToPatient: e.pricePharmacyToPatient ?? null,
              surveyName: surveyMap[e.surveyId] || '',
            };
          };

          // Match ALL entries with similar active ingredient (any dosage/form),
          // using fuzzy comparison to catch typos like pantoprazol vs pantaprazol.
          const ownActive = ownEntry?.activeIngredient || sciName || it.name;
          const matched = allEntries.filter(e => {
            const ai = aiMap[e.id];
            const candidate = ai?.activeIngredient || e.scientificName;
            if (activeMatchesAny(ownActive, candidate)) return true;
            if (!candidate && e.brandName && activeMatchesAny(ownActive, e.brandName)) return true;
            return false;
          });

          const ownRaw = ownEntry ? entryMap[ownEntry.entryId] : null;
          surveyMarket.ownProduct = ownRaw ? buildEntry(ownRaw) : null;
          surveyMarket.competitors = matched
            .filter(e => !ownRaw || e.id !== ownRaw.id)
            .map(buildEntry);
          if (matched.length) surveyMarket.matchMode = 'ai';
        }

        // Fallback fuzzy match if AI did not yield results
        if (surveyMarket.matchMode === 'none') {
          const searchActive = sciName || it.name;
          const matched = allEntries.filter(e => {
            if (e.scientificName && activeMatchesAny(searchActive, e.scientificName)) return true;
            if (!e.scientificName && e.brandName && activeMatchesAny(searchActive, e.brandName)) return true;
            return false;
          });
          if (matched.length) {
            surveyMarket.competitors = matched.map(e => ({
              brand: e.brandName,
              company: e.company || null,
              scientificName: e.scientificName || null,
              form: e.dosageForm || null,
              packaging: e.packaging || null,
              priceOfficeToWholesaler: e.priceOfficeToWholesaler ?? null,
              priceWholesalerToPharmacy: e.priceWholesalerToPharmacy ?? null,
              pricePharmacyToPatient: e.pricePharmacyToPatient ?? null,
              surveyName: surveyMap[e.surveyId] || '',
            }));
            surveyMarket.matchMode = 'fuzzy';
          }
        }
        surveyMarket.surveyCount = surveys.length;
      }
    } catch (err) {
      console.warn('[item-analysis] survey market fetch failed:', err?.message);
    }

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

# منافسون داخل نفس الشركة (مبيع داخلي)
${JSON.stringify(slim.competitors, null, 2)}

# 🔬 بيانات السيرفي الحقيقية للمنافسين (من ملف السوبر ادمن)
نمط التطابق: ${surveyMarket.matchMode} — عدد السيرفيات الفعّالة: ${surveyMarket.surveyCount}
${surveyMarket.ownProduct ? `## منتجنا (مُطابَق من السيرفي):
${JSON.stringify(surveyMarket.ownProduct, null, 2)}` : '## منتجنا غير موجود في السيرفي — اعتمد على بيانات الإيتم أعلاه فقط.'}

## المنافسون من السيرفي (${surveyMarket.competitors.length} منافس بنفس المادة الفعالة/الجرعة/الشكل):
${surveyMarket.competitors.length ? JSON.stringify(surveyMarket.competitors, null, 2) : 'لا توجد منافسين في السيرفي.'}
${repBlock}

# المطلوب
اكتب تقريراً منظماً بصيغة Markdown يحوي الأقسام التالية بالضبط. استخدم العناوين الرئيسية بصيغة (## رقم. عنوان) كما هي. اربط كل استنتاج بأرقام محددة من البيانات أعلاه. تجنّب الإطالة والعموميات.

## 💊 1. الملف العلمي للدواء (Drug Profile)
هذا القسم يُعرض في تبويب "المعلومات العلمية" — اجعله ملف علمي رسمي ومرجعي. استخدم تنسيق KV (مفتاح: قيمة) مختصر ومرتّب.

**Brand:** [اسم] | **Generic (الاسم العلمي):** [المادة الفعّالة]
**Drug Class (الفئة):** [الفئة العلاجية]
**Mechanism of Action (آلية العمل):** [جملة واحدة دقيقة]
**Indications (الاستخدامات الرئيسية):** [4-6 استخدامات]
**Contraindications (موانع الاستعمال):** [أهم 3-5]
**Common Side Effects (الأعراض الشائعة):** [قائمة]
**Serious Side Effects (الأعراض الخطيرة):** [قائمة]
**Pregnancy Category:** [FDA Cat. X — ملاحظة]
**Drug Interactions (تداخلات دوائية رئيسية):** [أهم 3-5]
**Pharmacokinetics:** Onset [..] | T½ [..] | Bioavailability [..] | Excretion [renal/hepatic]

### 🩺 الأطباء المستهدفون والأكثر وصفاً
استنتج علمياً + استدل من بيانات الزيارات أعلاه:
- اذكر تخصصات الأطباء الذين يصفون هذا الدواء عادة (Cardiologist, GP, Pediatrician, ...)
- رتّبهم حسب الأهمية (الأكثر وصفاً أولاً)
- لكل تخصص، اذكر السبب باختصار (لماذا هذا التخصص مهم لهذا الدواء)

### 💡 الرسالة العلمية المختصرة
3 نقاط رئيسية يمكن للمندوب استخدامها مع الطبيب — صياغة قصيرة وواضحة.

## 🏆 2. التحليل التنافسي العميق (Competitive Analysis)
هذا أهم قسم — اعتمد بشكل أساسي على بيانات السيرفي الحقيقية أعلاه (\`surveyMarket\`) ولا تخترع منافسين غير موجودين فيها.

### أ. جدول مقارنة الأسعار (من السيرفي)
${surveyMarket.competitors.length || surveyMarket.ownProduct ? 'أنشئ جدولاً Markdown بالأعمدة التالية لكل منتج (منتجنا أولاً ثم المنافسون):' : 'لا توجد بيانات سيرفي — اذكر ذلك صراحةً واطلب رفع سيرفي أسعار.'}

| المنتج | الشركة | الجرعة | الشكل | التعبئة | مكتب←مذخر | مذخر←صيدلية | صيدلية←مريض |
|---|---|---|---|---|---|---|---|

استخدم الأرقام كما هي من \`surveyMarket\`. ضع منتجنا في السطر الأول. إذا حقل غير موجود ضع "—".

### ب. تحليل نقاط القوة لمنتجنا مقابل كل منافس
لكل منافس في \`surveyMarket.competitors\`، اكتب فقرة قصيرة (سطرين) تقارن:
- **السعر**: هل منتجنا أرخص/أغلى؟ بكم نسبة مئوية؟
- **التعبئة والشكل الدوائي**: ميزة لنا أو للمنافس؟
- **الشركة المُصنّعة**: السمعة، التوفر في السوق
- **خلاصة**: نقطة قوة محددة يمكن للمندوب استخدامها

### ج. تموضع منتجنا في السوق (Market Positioning)
- أين يقع منتجنا في خانة السعر (أرخص / متوسط / أغلى)؟
- ما الفئة المستهدفة المثالية بناءً على هذا التموضع؟
- استراتيجية البيع المقترحة (سعر تنافسي، جودة عالية، توفر، علاقة مع طبيب…)

## 🔍 3. تشخيص أداء المبيع
حلل الأسباب الجذرية بالاعتماد على الأرقام:
- **نمط النمو**: هل المبيع ينمو، مستقر، أم يتراجع؟ (من \`monthlyTrend\`)
- **التوزيع الجغرافي**: مناطق قوية vs مناطق ضعيفة، وما السبب
- **العلاقة بين الزيارات والمبيع**: هل الزيارات تتحول إلى طلبات؟
- **سلوك الفيدباك**: ماذا تقول ملاحظات الأطباء؟ (من \`notesSamples\`)
- **فجوات التوزيع**: صيدليات بدون مبيع، مناطق غير مغطاة
${hasRep ? `
## 👤 4. التشخيص الخاص بالمندوب: ${slim.repName}
طبّق القواعد التشخيصية السبع المذكورة أعلاه على بيانات هذا المندوب. لكل قاعدة تنطبق:
- **اذكر الرقم المحدد** (مثلاً: "callCount=3 < 5 → قلة كولات واضحة")
- **حدد السبب الجذري**
- **اقترح إجراءً تصحيحياً محدداً** قابلاً للقياس
لا تذكر القواعد التي لا تنطبق. ركّز على الأكثر تأثيراً.
` : ''}
## 🎯 ${hasRep ? '5' : '4'}. اقتراحات عملية ${hasRep ? `للمندوب ${slim.repName}` : 'لفريق المبيعات'}
5-7 نقاط مرقّمة. كل نقطة:
- **الفعل المحدد** (ماذا يفعل بالضبط)
- **مع من** (طبيب، صيدلية، منطقة)
- **متى** (الأسبوع القادم، خلال شهر)
- **النتيجة المتوقعة** (قابلة للقياس)

## 📅 ${hasRep ? '6' : '5'}. خطة عمل 30 يوم تنفيذية
جدول بأربعة أعمدة:

| الأسبوع | الإجراء | المخرج المتوقع | المؤشر |
|---|---|---|---|

خطة مرتبطة مباشرةً بالتشخيص أعلاه. ${hasRep ? 'خاصة بهذا المندوب.' : 'موجّهة للفريق ككل.'}

# قواعد عامة صارمة
- ⚠️ **لا تخترع منافسين غير موجودين في \`surveyMarket\`** — إذا كانت قائمة المنافسين فارغة، قل ذلك صراحةً
- استشهد بأرقام محددة في كل استنتاج (سعر، عدد، نسبة)
- لا تكتب فقرات إنشائية طويلة — كل فكرة في سطر أو سطرين
- استخدم الجداول والقوائم بدل الفقرات الطويلة
- المعلومات العلمية يجب أن تكون دقيقة طبياً
- لا تكرر العناوين، لا تخلط الأقسام، التزم بالترقيم بدقة`;

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

// ─── POST /api/item-analysis/survey/ai-analyze-all ──────────────────────────
// Find ALL active drug_price surveys and analyze each with Gemini
export async function analyzeAllSurveysWithAI(req, res, next) {
  try {
    const surveys = await prisma.masterSurvey.findMany({
      where: { surveyType: 'drug_prices', isActive: true },
      select: { id: true, name: true },
    });

    if (!surveys.length) {
      return res.json({ ok: true, surveyCount: 0, results: [], message: 'لا توجد سيرفيات أسعار نشطة' });
    }

    const results = [];
    for (const survey of surveys) {
      const entries = await prisma.drugPriceSurveyEntry.findMany({
        where: { surveyId: survey.id },
        select: { id: true, brandName: true, scientificName: true, dosageForm: true, packaging: true },
      });

      if (!entries.length) {
        results.push({ surveyId: survey.id, surveyName: survey.name, status: 'skipped', reason: 'no entries' });
        continue;
      }

      const entryList = entries.map(e => ({
        id: e.id, brand: e.brandName, sci: e.scientificName || '', form: e.dosageForm || '', pkg: e.packaging || '',
      }));

      const prompt = `أنت خبير صيدلاني. لديك قائمة أدوية من سيرفي أسعار.
مهمتك: لكل دواء، استخرج المعلومات التالية بدقة:
- entryId: نفس id المعطى
- activeIngredient: المادة الفعالة الرئيسية (بالإنجليزية، موحدة ومعيارية، مثال: "tiotropium bromide")
- drugClass: الصنف الدوائي (مثال: "anticholinergic bronchodilator")
- dosageAmount: كمية الجرعة فقط (مثال: "18")
- dosageUnit: الوحدة فقط (مثال: "mcg" أو "mg" أو "ml") — إذا غير موجود اترك فارغاً
- dosageForm: الشكل الدوائي الموحد بالإنجليزية الصغيرة (spray / tablet / capsule / injection / syrup / cream / drops)
- competitorGroup: مفتاح فريد يجمع الأدوية المتنافسة (نفس المادة الفعالة + نفس الجرعة + نفس الشكل)
  مثال: "tiotropium-18mcg-spray" أو "amoxicillin-500mg-capsule"
  إذا لم تستطع تحديد الجرعة، استخدم المادة الفعالة فقط: مثال "tiotropium-spray"

قاعدة مهمة: أدوية بنفس المادة الفعالة + نفس الجرعة + نفس الشكل يجب أن تحمل نفس competitorGroup بغض النظر عن الاسم التجاري أو الشركة.

القائمة (${entries.length} دواء):
${JSON.stringify(entryList)}

أعد JSON فقط — مصفوفة بدون أي نص إضافي:
[{"entryId":1,"activeIngredient":"...","drugClass":"...","dosageAmount":"...","dosageUnit":"...","dosageForm":"...","competitorGroup":"..."}]`;

      let rawResult;
      try { rawResult = await callGeminiSmart([{ text: prompt }]); }
      catch (err) {
        await prisma.surveyAIAnalysis.upsert({
          where: { surveyId: survey.id },
          create: { surveyId: survey.id, analysisJson: '[]', entryCount: 0, status: 'error', errorMsg: err?.message, updatedAt: new Date() },
          update: { status: 'error', errorMsg: err?.message, updatedAt: new Date() },
        });
        results.push({ surveyId: survey.id, surveyName: survey.name, status: 'error', reason: 'Gemini error' });
        continue;
      }

      let analysisArray;
      try {
        const cleaned = rawResult.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        analysisArray = JSON.parse(cleaned);
        if (!Array.isArray(analysisArray)) throw new Error('not array');
      } catch {
        results.push({ surveyId: survey.id, surveyName: survey.name, status: 'error', reason: 'JSON parse error' });
        continue;
      }

      await prisma.surveyAIAnalysis.upsert({
        where: { surveyId: survey.id },
        create: { surveyId: survey.id, analysisJson: JSON.stringify(analysisArray), entryCount: analysisArray.length, status: 'done', generatedAt: new Date(), updatedAt: new Date() },
        update: { analysisJson: JSON.stringify(analysisArray), entryCount: analysisArray.length, status: 'done', generatedAt: new Date(), updatedAt: new Date() },
      });

      results.push({ surveyId: survey.id, surveyName: survey.name, status: 'done', entryCount: analysisArray.length });
    }

    const done = results.filter(r => r.status === 'done').length;
    res.json({ ok: true, surveyCount: surveys.length, done, results });
  } catch (e) { next(e); }
}

// ─── POST /api/item-analysis/survey/:surveyId/ai-analyze ────────────────
// Analyze a drug_price survey with Gemini → store normalised index in survey_ai_analyses
export async function analyzeSurveyWithAI(req, res, next) {
  try {
    const surveyId = Number(req.params.surveyId);
    if (!surveyId) return res.status(400).json({ error: 'surveyId required' });

    const survey = await prisma.masterSurvey.findUnique({
      where: { id: surveyId },
      select: { id: true, name: true, surveyType: true },
    });
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    if (survey.surveyType !== 'drug_prices') {
      return res.status(400).json({ error: 'السيرفي ليس من نوع drug_prices' });
    }

    const entries = await prisma.drugPriceSurveyEntry.findMany({
      where: { surveyId },
      select: {
        id: true, brandName: true, scientificName: true, company: true,
        dosageForm: true, packaging: true,
        priceOfficeToWholesaler: true, priceWholesalerToPharmacy: true, pricePharmacyToPatient: true,
      },
    });

    if (!entries.length) {
      return res.status(400).json({ error: 'لا توجد مدخلات في هذا السيرفي' });
    }

    // Build compact representation for Gemini (limit to essential fields)
    const entryList = entries.map(e => ({
      id: e.id,
      brand: e.brandName,
      sci: e.scientificName || '',
      form: e.dosageForm || '',
      pkg: e.packaging || '',
    }));

    const prompt = `أنت خبير صيدلاني. لديك قائمة أدوية من سيرفي أسعار.
مهمتك: لكل دواء، استخرج المعلومات التالية بدقة:
- entryId: نفس id المعطى
- activeIngredient: المادة الفعالة الرئيسية (بالإنجليزية، موحدة ومعيارية، مثال: "tiotropium bromide")
- drugClass: الصنف الدوائي (مثال: "anticholinergic bronchodilator")
- dosageAmount: كمية الجرعة فقط (مثال: "18")
- dosageUnit: الوحدة فقط (مثال: "mcg" أو "mg" أو "ml") — إذا غير موجود اترك فارغاً
- dosageForm: الشكل الدوائي الموحد بالإنجليزية الصغيرة (مثال: "spray" أو "tablet" أو "capsule" أو "injection" أو "syrup" أو "cream" أو "drops")
- competitorGroup: مفتاح فريد يجمع الأدوية المتنافسة (نفس المادة الفعالة + نفس الجرعة + نفس الشكل)
  مثال: "tiotropium-18mcg-spray" أو "amoxicillin-500mg-capsule"
  إذا لم تستطع تحديد الجرعة، استخدم المادة الفعالة فقط: مثال "tiotropium-spray"

قاعدة مهمة: أدوية بنفس المادة الفعالة + نفس الجرعة + نفس الشكل يجب أن تحمل نفس competitorGroup بغض النظر عن الاسم التجاري أو الشركة.

القائمة (${entries.length} دواء):
${JSON.stringify(entryList)}

أعد JSON فقط — مصفوفة بدون أي نص إضافي:
[{"entryId":1,"activeIngredient":"...","drugClass":"...","dosageAmount":"...","dosageUnit":"...","dosageForm":"...","competitorGroup":"..."}]`;

    let rawResult;
    try {
      rawResult = await callGeminiSmart([{ text: prompt }]);
    } catch (err) {
      await prisma.surveyAIAnalysis.upsert({
        where: { surveyId },
        create: { surveyId, analysisJson: '[]', entryCount: 0, status: 'error', errorMsg: err?.message },
        update: { status: 'error', errorMsg: err?.message, updatedAt: new Date() },
      });
      return res.status(503).json({ error: 'Gemini غير متاح حالياً. حاول لاحقاً.' });
    }

    // Parse JSON from Gemini response (strip markdown fences if present)
    let analysisArray;
    try {
      const cleaned = rawResult.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      analysisArray = JSON.parse(cleaned);
      if (!Array.isArray(analysisArray)) throw new Error('not array');
    } catch {
      await prisma.surveyAIAnalysis.upsert({
        where: { surveyId },
        create: { surveyId, analysisJson: '[]', entryCount: 0, status: 'error', errorMsg: 'Invalid JSON from Gemini' },
        update: { status: 'error', errorMsg: 'Invalid JSON from Gemini', updatedAt: new Date() },
      });
      return res.status(502).json({ error: 'لم يتمكن الذكاء الاصطناعي من معالجة البيانات. حاول مرة أخرى.' });
    }

    await prisma.surveyAIAnalysis.upsert({
      where: { surveyId },
      create: { surveyId, analysisJson: JSON.stringify(analysisArray), entryCount: analysisArray.length, status: 'done', generatedAt: new Date(), updatedAt: new Date() },
      update: { analysisJson: JSON.stringify(analysisArray), entryCount: analysisArray.length, status: 'done', generatedAt: new Date(), updatedAt: new Date() },
    });

    res.json({ ok: true, surveyId, entryCount: analysisArray.length, surveyName: survey.name });
  } catch (e) { next(e); }
}

// ─── GET /api/item-analysis/:itemId/market-prices ─────────────
// Returns drug price data: own product + competitors, using AI analysis when available
export async function getMarketPrices(req, res, next) {
  try {
    const itemId = Number(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'itemId required' });

    const item = await prisma.item.findUnique({
      where: { id: itemId },
      select: { name: true, scientificName: true, dosage: true, form: true },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Find all active drug_prices surveys
    const surveys = await prisma.masterSurvey.findMany({
      where: { surveyType: 'drug_prices', isActive: true },
      select: { id: true, name: true },
    });
    if (!surveys.length) return res.json({ data: [], surveyCount: 0, matchMode: 'none' });

    const surveyIds = surveys.map(s => s.id);
    const surveyMap = Object.fromEntries(surveys.map(s => [s.id, s.name]));

    // Load all entries for these surveys
    const allEntries = await prisma.drugPriceSurveyEntry.findMany({
      where: { surveyId: { in: surveyIds } },
      orderBy: [{ brandName: 'asc' }],
    });

    // Check if AI analyses exist for any of these surveys
    const aiAnalyses = await prisma.surveyAIAnalysis.findMany({
      where: { surveyId: { in: surveyIds }, status: 'done' },
      select: { surveyId: true, analysisJson: true },
    });

    const entryMap = Object.fromEntries(allEntries.map(e => [e.id, e]));

    if (aiAnalyses.length > 0) {
      // ── AI-powered matching ──────────────────────────────────────────
      // Build a flat index of all analyzed entries
      const analyzedEntries = [];
      for (const ai of aiAnalyses) {
        try {
          const arr = JSON.parse(ai.analysisJson);
          for (const a of arr) analyzedEntries.push({ ...a, _surveyId: ai.surveyId });
        } catch {}
      }

      const normalName = item.name.trim().toLowerCase().replace(/\s+/g, '');
      const sciName = (item.scientificName || '').trim();

      // Step 1: Find the own-product entry (closest brand name match)
      let ownEntry = null;

      // Try exact/near brand match first
      for (const a of analyzedEntries) {
        const raw = entryMap[a.entryId];
        if (!raw) continue;
        const bn = raw.brandName.trim().toLowerCase().replace(/\s+/g, '');
        const bnBase = bn.replace(/[\d\.]+\s*(mg|mcg|ml|g|iu|%)/g, '').trim();
        const nameBase = normalName.replace(/[\d\.]+\s*(mg|mcg|ml|g|iu|%)/g, '').trim();
        if (bn === normalName || normalName.includes(bn) || bn.includes(nameBase) || nameBase.includes(bnBase)) {
          ownEntry = a;
          break;
        }
      }

      // Fallback: fuzzy active-ingredient match (handles typos)
      if (!ownEntry && sciName) {
        for (const a of analyzedEntries) {
          if (activeMatchesAny(sciName, a.activeIngredient)) {
            ownEntry = a;
            break;
          }
        }
      }

      // Step 2: Determine the canonical active ingredient to search by.
      // Priority: AI-identified own product → item's scientific name → item brand name
      const ownActive = ownEntry?.activeIngredient || sciName || item.name;

      // Match ALL entries whose active ingredient is similar — across any
      // dosage / form / packaging — so the user sees every related competitor.
      const aiMap = Object.fromEntries(analyzedEntries.map(a => [a.entryId, a]));

      const matchedEntries = allEntries.filter(e => {
        const ai = aiMap[e.id];
        // Try AI-extracted active ingredient first; fall back to raw scientific name
        const candidate = ai?.activeIngredient || e.scientificName;
        if (activeMatchesAny(ownActive, candidate)) return true;
        // Also catch entries whose brand name itself contains the active stem
        // (rare cases where AI failed and scientific name is empty)
        if (!candidate && e.brandName && activeMatchesAny(ownActive, e.brandName)) return true;
        return false;
      });

      const data = matchedEntries.map(e => {
        const ai = aiMap[e.id];
        const isOwnProduct = ownEntry ? e.id === entryMap[ownEntry.entryId]?.id : false;
        return {
          ...e,
          surveyName: surveyMap[e.surveyId] || '',
          isOwnProduct,
          activeIngredient: ai?.activeIngredient || null,
          drugClass: ai?.drugClass || null,
          dosageAmountAI: ai?.dosageAmount || null,
          dosageUnitAI: ai?.dosageUnit || null,
          dosageFormAI: ai?.dosageForm || null,
          competitorGroup: ai?.competitorGroup || null,
        };
      });

      // Sort: own product first, then competitors
      data.sort((a, b) => (b.isOwnProduct ? 1 : 0) - (a.isOwnProduct ? 1 : 0));

      return res.json({
        data, surveyCount: surveys.length, matchMode: 'ai', surveysAnalyzed: aiAnalyses.length,
        searchedActive: ownActive,
      });
    }

    // ── Fallback: fuzzy active-ingredient matching (no AI analysis available) ────────
    // Even without survey AI analysis, still match by similar scientific names so
    // typos like "pantaprazol" vs "pantoprazole" are caught.
    const sciName = (item.scientificName || '').trim();
    const searchActive = sciName || item.name;
    const matched = allEntries.filter(e => {
      // Compare the item's active ingredient against the entry's scientific name
      // (preferred) and brand name (fallback).
      if (e.scientificName && activeMatchesAny(searchActive, e.scientificName)) return true;
      if (!e.scientificName && e.brandName && activeMatchesAny(searchActive, e.brandName)) return true;
      return false;
    });

    const data = matched.map(e => ({ ...e, surveyName: surveyMap[e.surveyId] || '' }));
    res.json({
      data, surveyCount: surveys.length, matchMode: 'fuzzy', surveysAnalyzed: 0,
      searchedActive: searchActive,
    });
  } catch (e) { next(e); }
}
