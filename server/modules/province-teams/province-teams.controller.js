// ════════════════════════════════════════════════════════════════════════════
// province-teams.controller.js — واجهة HTTP لفرق المحافظات.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { loadViewer } from './province-teams.access.js';
import * as structure from './province-teams.service.js';
import { resolveCoverageFiles, listCoverageMonths, computeCoverage } from './province-coverage.js';
import * as personal from './personal-sales.service.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';
import { buildMonthFilter, monthToRange, UNDATED_CUTOFF } from '../../lib/salesMonths.js';
import { loadConditionSalesForReps } from '../../lib/conditionFile.js';
import { PHARMACY_KIND } from '../../lib/pharmacyRep.js';
import { loadManagerSeat, loadSeatManagers, loadSharedRepScopes } from '../../lib/provinceSeats.js';
import { loadSplitPlansForReps } from '../../lib/provinceSplit.js';
import { assignmentFillsSeat, attributeLine, repSeatIds, repTeamCompany } from './province-teams.rules.js';
import { liquidationProvinces, loadLiquidationData } from '../scientific-reps/scientific-reps.service.js';
import { saleValueUSD } from '../sales/sales.repository.js';

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

/**
 * مبيع مندوبي الفرق لكل محافظة وحساب وايتم، بالدولار كبقية الأرقام.
 * @returns {Promise<Map<string, Map<string|number, {itemId:number|null, itemName:string, qty:number, usd:number, rows:number, pharmacies:Set<string>}>>>}
 *   المفتاح `${محافظة}|${حساب}`
 */
async function loadTeamLiquidation(repUserIds, files, month, viewerId, onLine = null) {
  const out = new Map();
  if (!repUserIds.length) return out;
  const { sales, mercatoRows, users, ownerOfRow } = await loadLiquidationData({
    fileIds: files.mercatoFileIds,
    range: monthToRange(month) ?? {},
    repSaleWhere: { createdById: { in: repUserIds } },
    userWhere: { id: { in: repUserIds } },
    viewerId,
  });
  const province = await liquidationProvinces(sales, mercatoRows, ownerOfRow, { extraUserIds: users.map(u => u.id) });
  const plans = await loadSplitPlansForReps(repUserIds);
  // مقعد مقسَّم بغير المرسل: السطر يُحسب لحامله، وما لا يطابقه أحد يبقى لمرسله.
  const receiverOf = (provinceName, senderId, itemId, area, customer) => {
    const plan = plans.get(provinceName);
    return plan ? attributeLine({ senderId, itemId, area, customer }, plan) : senderId;
  };
  const add = (provinceName, userId, itemId, itemName, qty, usd, pharmacy) => {
    const k = `${provinceName}|${userId}`;
    if (!out.has(k)) out.set(k, new Map());
    const key = itemId ?? `n:${itemName}`;
    const cell = out.get(k).get(key) ?? { itemId, itemName, qty: 0, usd: 0, rows: 0, pharmacies: new Set() };
    cell.qty += qty; cell.usd += usd; cell.rows += 1;
    if (pharmacy) cell.pharmacies.add(pharmacy);
    out.get(k).set(key, cell);
  };
  const rate = files.rate || 1470;
  for (const s of sales) {
    const provinceName = province.ofSale(s);
    for (const l of s.lines) {
      const receiver = receiverOf(provinceName, s.createdById, l.itemId, s.areaName, s.pharmacyName);
      const usd = l.quantity * (l.unitPrice ?? 0) / rate;
      add(provinceName, receiver, l.itemId, l.itemName, l.quantity, usd, s.pharmacyName);
      onLine?.(provinceName, receiver, {
        date: dayOf(s.saleDate), invoice: s.invoiceNumber ?? '', pharmacy: s.pharmacyName ?? '', area: s.areaName ?? '',
        warehouse: s.warehouseName ?? '', itemId: l.itemId ?? null, item: l.itemName ?? '', company: l.companyName ?? '',
        quantity: l.quantity, bonus: l.bonusQty ?? 0, usd, source: 'مبيعات المندوب',
      });
    }
  }
  for (const r of mercatoRows) {
    const sign = String(r.recordType ?? '').trim().toLowerCase() === 'return' ? -1 : 1;
    // حسابان بالاسم نفسه: يُحسب الصف لكلٍّ منهما كما في تقريره، وايتماتهما هي الفاصل.
    const counted = new Set();
    for (const u of users.filter(x => r.repIds.includes(x.linkedRepId))) {
      const provinceName = province.ofRow(r, u.id);
      const receiver = receiverOf(provinceName, u.id, r.itemId, r.area?.name, r.customer?.name);
      if (counted.has(`${provinceName}|${receiver}`)) continue;
      counted.add(`${provinceName}|${receiver}`);
      add(provinceName, receiver, r.itemId, r.item?.name ?? `#${r.itemId}`, sign * r.quantity, sign * saleValueUSD(r), sign > 0 ? r.customer?.name : null);
      if (onLine) {
        const raw = rawOf(r.rawData);
        const condition = String(r.uploadedFile?.mergeGroup ?? '').endsWith('|condition');
        onLine(provinceName, receiver, {
          date: dayOf(r.saleDate), invoice: String(raw.invoiceNumber ?? rawCol(raw, INVOICE_KEY_RE) ?? '').trim(),
          pharmacy: String(raw.pharmacy || r.customer?.name || '').trim(),
          area: r.area?.name && r.area.name !== 'غير محدد' ? r.area.name : '',
          warehouse: String(raw.warehouse ?? rawCol(raw, WAREHOUSE_NAME_KEY_RE, WAREHOUSE_NOT_NAME_RE) ?? '').trim(),
          itemId: r.itemId ?? null, item: r.item?.name ?? `#${r.itemId}`,
          company: String(raw.company ?? rawCol(raw, COMPANY_KEY_RE) ?? '').trim(),
          quantity: sign * r.quantity, bonus: Number(raw.bonus ?? rawCol(raw, BONUS_KEY_RE)) || 0, usd: sign * saleValueUSD(r),
          source: sign < 0 ? 'إرجاع' : condition ? (LIQ_SOURCE_LABEL[raw.source] || 'ملف اللكوديشن') : 'ميركاتو',
        });
      }
    }
  }
  return out;
}

const dayOf = (d) => (d && new Date(d) >= UNDATED_CUTOFF ? new Date(d).toISOString().slice(0, 10) : '');
const rawOf = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v || '{}') || {}; } catch { return {}; } };
const INVOICE_KEY_RE = /رقم\s*(ال)?(فاتور|طلب)|invoice/i;
// ميركاتو فيه «رقم طلبية المذخر» و«حالة طلبية المذخر» قبل «اسم المذخر»: نأخذ عمود الاسم لا الرقم/الحالة.
const WAREHOUSE_NAME_KEY_RE = /مذخر|warehouse|distributor/i;
const WAREHOUSE_NOT_NAME_RE = /رقم|حال|طلبي|number|status|no\b/i;
// «الصنف» في ميركاتو = الشركة المصنّعة (راجع mercatoColumnMap).
const COMPANY_KEY_RE = /^(ال)?صنف$|^company$/i;
const BONUS_KEY_RE = /بونص|bonus/i;
const rawCol = (raw, re, notRe = null) => {
  const k = Object.keys(raw).find(x => re.test(x.trim()) && !(notRe && notRe.test(x)) && String(raw[x] ?? '').trim() !== '');
  return k ? raw[k] : null;
};
const LIQ_SOURCE_LABEL = {
  'telegram-order': 'بوت تلكرام', 'viber-order': 'بوت فايبر', 'whatsapp-order': 'بوت واتساب',
  'warehouse-gap-template': 'إكسل اللكوديشن', 'manual-invoice': 'فاتورة يدوية',
};

// ── GET /api/province-teams/rep-lines?repUserId=&province=&month=&fileIds= ──────
// سطور لكوديشن مندوب علمي في محافظة: نفس بيانات personalNet في /directory (loadTeamLiquidation
// بالمندوبين أنفسهم وتقسيم المقاعد نفسه)، فمجموعها = رقم المندوب في نافذة الفرق. القيم بالدولار.
export async function repLines(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    const month = String(req.query.month ?? '').trim() || 'all';
    const repUserId = toInt(req.query.repUserId);
    const norm = (x) => String(x ?? '').trim().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ');
    const [teams, files] = await Promise.all([
      structure.loadVisibleTeams(viewer),
      resolveCoverageFiles(viewer, req.query.fileIds),
    ]);
    const has = (t) => t.assignments.some(a => a.repUserId === repUserId);
    const team = teams.find(t => has(t) && norm(t.provinceName) === norm(req.query.province)) ?? teams.find(has);
    if (!repUserId || !team) return res.status(404).json({ success: false, message: 'المندوب غير موجود في فرق المحافظات المرئية لك' });

    const allowed = viewer.mode === 'company' ? await resolveEffectiveItemIds(viewer.id) : null;
    const seat = await loadManagerSeat(viewer.id);
    const shared = seat ? (await loadSharedRepScopes(viewer.id)).byUser.get(repUserId) : null;
    const allowedSet = shared ?? (allowed ? new Set(allowed) : null);

    const repIds = [...new Set(teams.flatMap(t => t.assignments.map(a => a.repUserId)))];
    const rows = [];
    await loadTeamLiquidation(repIds, files, month, viewer.id, (provinceName, userId, line) => {
      if (provinceName !== team.provinceName || userId !== repUserId) return;
      if (allowedSet && !allowedSet.has(line.itemId)) return;
      rows.push({ ...line, province: provinceName, usd: +line.usd.toFixed(4) });
    });
    // سطر بلا شركة (ملف قديم أو سطر مندوب لم تُكتب شركته): شركة الايتم من الكتالوج.
    const missing = [...new Set(rows.filter(r => !r.company && r.itemId).map(r => r.itemId))];
    if (missing.length) {
      const items = await prisma.item.findMany({ where: { id: { in: missing } }, select: { id: true, company: { select: { name: true } }, scientificCompany: { select: { name: true } } } });
      const co = new Map(items.map(i => [i.id, i.company?.name || i.scientificCompany?.name || '']));
      for (const r of rows) if (!r.company && r.itemId) r.company = co.get(r.itemId) || '';
    }
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.pharmacy.localeCompare(b.pharmacy, 'ar'));
    const repName = team.assignments.find(a => a.repUserId === repUserId)?.repName ?? '';
    res.json({ success: true, month, province: team.provinceName, repName, files: { currency: files.currency, rate: files.rate }, rows });
  } catch (e) { next(e); }
}

// ── GET /api/province-teams/all-lines?month=&fileIds=&day=YYYY-MM-DD ───────────
// لكوديشن كل المحافظات سطراً سطراً (زر «لكوديشن كل المحافظات» في «مندوبين المحافظات»):
// نفس سطور rep-lines لكل مندوب علمي يظهر في جدول الأسماء — نفس شروط /directory (مقعد مدير
// الشركة، ايتماته، المسوقون خارجاً، العلمي تحت قائد محافظته فقط، بلا بغداد) — فمجموع كل
// مندوب = رقم «اللكوديشن» أمامه. day = يوم واحد (يتجاوز month). القيم بالدولار.
export async function allLines(req, res, next) {
  try {
    const viewer = await loadViewer(req.user);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day ?? '')) ? String(req.query.day) : null;
    const month = day ? day.slice(0, 7) : (String(req.query.month ?? '').trim() || 'all');
    const norm = (x) => String(x ?? '').trim().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ');
    const [allTeams, files] = await Promise.all([
      structure.loadVisibleTeams(viewer),
      resolveCoverageFiles(viewer, req.query.fileIds),
    ]);
    const teams = allTeams.filter(t => norm(t.provinceName) !== norm('بغداد'));

    const allowed = viewer.mode === 'company' ? await resolveEffectiveItemIds(viewer.id) : null;
    const allowedBase = allowed ? new Set(allowed) : null;
    const seat = await loadManagerSeat(viewer.id);
    const sharedScopes = seat ? (await loadSharedRepScopes(viewer.id)).byUser : new Map();
    const allowedFor = (repUserId) => sharedScopes.get(repUserId) ?? allowedBase;
    const officeSeats = seat ? (await loadSeatManagers([seat.officeId])).filter(s => s.officeId === seat.officeId) : [];
    const explicit = (a) => ({ companyId: a.companyId, allItems: a.allItems, itemIds: a.explicitItemIds });
    const repInViewerSeat = (t, a) => repSeatIds(
      t.allAssignments.filter(o => o.repUserId === a.repUserId).map(explicit), a.repManagerIds, officeSeats,
    ).includes(seat.userId);

    const repIds = [...new Set(teams.flatMap(t => t.assignments.map(a => a.repUserId)))];
    // المسوقون (repKind pharmacy) لا لكوديشن لهم هنا
    const marketerIds = new Set();
    if (repIds.length) {
      const [users, repRows] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, linkedRepId: true } }),
        prisma.scientificRepresentative.findMany({ where: { userId: { in: repIds } }, select: { id: true, userId: true } }),
      ]);
      const link = new Map(repRows.map(r => [r.userId, r.id]));
      for (const u of users) if (u.linkedRepId && !link.has(u.id)) link.set(u.id, u.linkedRepId);
      const kinds = await prisma.scientificRepresentative.findMany({ where: { id: { in: [...new Set(link.values())] } }, select: { id: true, repKind: true } });
      const kindOf = new Map(kinds.map(k => [k.id, k.repKind]));
      for (const [u, r] of link) if (kindOf.get(r) === PHARMACY_KIND) marketerIds.add(u);
    }

    // `${محافظة}|${حساب}` → { المندوب، قائده، مجموعة ايتماته المسموحة }
    const shown = new Map();
    const repAllowedCache = new Map();
    for (const t of teams) {
      for (const a of t.assignments) {
        if (marketerIds.has(a.repUserId)) continue;
        if (seat && !(assignmentFillsSeat(explicit(a), seat) && repInViewerSeat(t, a))) continue;
        const allowedSet = allowedFor(a.repUserId);
        if (allowedSet) {
          // مثل /directory: مندوب لا يعمل على أي ايتم من ايتمات المدير (وقائمة حسابه) لا يظهر له
          if (!repAllowedCache.has(a.repUserId)) {
            const ids = await resolveEffectiveItemIds(a.repUserId);
            repAllowedCache.set(a.repUserId, ids ? new Set(ids) : null);
          }
          const repSet = repAllowedCache.get(a.repUserId);
          if (!a.itemIds.some(id => allowedSet.has(id) && (!repSet || repSet.has(id)))) continue;
        }
        const underLeader = t.leaderUserId == null || t.assignments.some(x => x.repUserId === a.repUserId && (x.repManagerIds ?? []).includes(t.leaderUserId));
        if (!underLeader) continue;
        const k = `${t.provinceName}|${a.repUserId}`;
        if (!shown.has(k)) shown.set(k, { repName: a.repName, leaderName: t.leaderName ?? '', allowedSet });
      }
    }

    const rows = [];
    await loadTeamLiquidation(repIds, files, month, viewer.id, (provinceName, userId, line) => {
      const s = shown.get(`${provinceName}|${userId}`);
      if (!s) return;
      if (s.allowedSet && !s.allowedSet.has(line.itemId)) return;
      if (day && line.date !== day) return;
      rows.push({ ...line, province: provinceName, repUserId: userId, repName: s.repName, leaderName: s.leaderName, usd: +line.usd.toFixed(4) });
    });
    const missing = [...new Set(rows.filter(r => !r.company && r.itemId).map(r => r.itemId))];
    if (missing.length) {
      const items = await prisma.item.findMany({ where: { id: { in: missing } }, select: { id: true, company: { select: { name: true } }, scientificCompany: { select: { name: true } } } });
      const co = new Map(items.map(i => [i.id, i.company?.name || i.scientificCompany?.name || '']));
      for (const r of rows) if (!r.company && r.itemId) r.company = co.get(r.itemId) || '';
    }
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.pharmacy.localeCompare(b.pharmacy, 'ar'));
    res.json({ success: true, month, day, files: { currency: files.currency, rate: files.rate }, rows });
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
    const allowedBase = allowed ? new Set(allowed) : null;
    const seat = await loadManagerSeat(viewer.id);
    // المندوب المشترك: ايتم مسند لمديريه معاً يظهر عند مالكه فقط، فلا يتكرر مبيعه.
    const sharedScopes = seat ? (await loadSharedRepScopes(viewer.id)).byUser : new Map();
    const allowedFor = (repUserId) => sharedScopes.get(repUserId) ?? allowedBase;
    const allSeats = await loadSeatManagers([...new Set([...teams.map(t => t.officeId), seat?.officeId].filter(Boolean))]);
    const officeSeats = seat ? allSeats.filter(s => s.officeId === seat.officeId) : [];
    const explicit = (a) => ({ companyId: a.companyId, allItems: a.allItems, itemIds: a.explicitItemIds });
    // شركة واحدة تمثل تيم المندوب. مدير الشركة لا يرى إلا مندوبي مقعده، فهي شركته. المسوق بلا تيم شركة.
    const teamCompanyOf = (t, repUserId, isMarketer) => {
      if (isMarketer) return null;
      if (seat) return seat.companyName;
      const own = t.allAssignments.filter(a => a.repUserId === repUserId);
      return repTeamCompany(
        own.map(a => ({ ...explicit(a), companyName: a.companyName, isPrimary: a.isRepPrimaryCompany })),
        own[0]?.repManagerIds ?? [],
        allSeats.filter(s => s.officeId === t.officeId),
      );
    };
    // ايتم مشترك مع مدير آخر لا يدخل مندوب ذلك المدير في فريق المُشاهِد.
    const repInViewerSeat = (t, a) => repSeatIds(
      t.allAssignments.filter(o => o.repUserId === a.repUserId).map(explicit), a.repManagerIds, officeSeats,
    ).includes(seat.userId);

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
    const repKindOf = new Map(); // ScientificRepresentative.id → repKind (عرض الأسماء يفصل العلميين عن المسوقين)
    const targetsByRep = new Map(); // `${userId}|${itemId}` → qty
    // القادة يدخلون الربط فقط كي يُفتح تقرير التيم ليدر من عرض الأسماء
    const linkIds = [...new Set([...repIds, ...teams.map(t => t.leaderUserId).filter(Boolean)])];
    if (linkIds.length) {
      const [users, repRows] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: linkIds } }, select: { id: true, linkedRepId: true } }),
        prisma.scientificRepresentative.findMany({ where: { userId: { in: linkIds } }, select: { id: true, userId: true } }),
      ]);
      for (const r of repRows) repLink.set(r.userId, r.id);
      for (const u of users) if (u.linkedRepId && !repLink.has(u.id)) repLink.set(u.id, u.linkedRepId);
      const kinds = await prisma.scientificRepresentative.findMany({ where: { id: { in: [...new Set(repLink.values())] } }, select: { id: true, repKind: true } });
      for (const k of kinds) repKindOf.set(k.id, k.repKind);
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

    // ── مبيع المندوب العلمي: المؤكد في «مبيعات المندوبين» + ميركاتو واللكوديشن باسمه، في محافظة الفريق ──
    const liquidation = await loadTeamLiquidation(repIds, files, month, viewer.id);

    const out = [];
    for (const t of teams) {
      const cov = coverage.get(t.id);
      const repsMap = new Map();
      const newItem = (id, name, company) => ({ itemId: id, name, company, net: 0, qty: 0, targetQty: 0, personalQty: 0, personalNet: 0 });
      for (const a of t.assignments) {
        // مدير الشركة: مندوب مقعده فقط. a.itemIds تتوسّع لكل ايتمات الشركة مع «كل الايتمات»
        // فتتقاطع مع ايتم مسند له من شركة غيره، لذا الحكم بالتعيين الصريح.
        const isMarketer = repKindOf.get(repLink.get(a.repUserId)) === PHARMACY_KIND;
        if (seat && !isMarketer && !(assignmentFillsSeat(explicit(a), seat) && repInViewerSeat(t, a))) continue;
        const allowedSet = allowedFor(a.repUserId);
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
        const allowedSet = allowedFor(r.repUserId);
        const nameByItem = new Map();
        for (const a of t.assignments) if (a.repUserId === r.repUserId) for (const id of a.itemIds) nameByItem.set(id, a.companyName);
        if (repKindOf.get(repLink.get(r.repUserId)) !== PHARMACY_KIND) {
          for (const c of liquidation.get(`${t.provinceName}|${r.repUserId}`)?.values() ?? []) {
            if (allowedSet && !allowedSet.has(c.itemId)) continue;
            const key = c.itemId ?? `n:${c.itemName}`;
            let cur = r.items.get(key);
            if (!cur) { cur = newItem(c.itemId, c.itemName, (c.itemId && nameByItem.get(c.itemId)) || '—'); r.items.set(key, cur); }
            cur.personalQty += c.qty; cur.personalNet += c.usd;
            r.personalQty += c.qty; r.personalNet += c.usd;
          }
          continue;
        }
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
        repId: repLink.get(r.repUserId) ?? null,
        repKind: repKindOf.get(repLink.get(r.repUserId)) ?? 'scientific',
        // التيم ليدر مُعيَّن مديراً للمندوب؟ (مقعد القائد شاغر ⇒ أعضاء الفريق يظهرون). عرض الأسماء يُخفي العلمي غير المربوط بقائد محافظته.
        underLeader: t.leaderUserId == null ? true : t.assignments.some(a => a.repUserId === r.repUserId && (a.repManagerIds ?? []).includes(t.leaderUserId)),
        teamCompany: teamCompanyOf(t, r.repUserId, repKindOf.get(repLink.get(r.repUserId)) === PHARMACY_KIND),
        net: +r.net.toFixed(2),
        personalNet: +r.personalNet.toFixed(2),
        // رقم المندوب نفسه؛ net = مبيع الشركة في المحافظة على ايتماته. المسوق يبقى على قواعده.
        repNet: +(repKindOf.get(repLink.get(r.repUserId)) === PHARMACY_KIND ? r.net : r.personalNet).toFixed(2),
        items: [...r.items.values()].map(({ targetCounted, ...i }) => ({ ...i, net: +i.net.toFixed(2), personalNet: +i.personalNet.toFixed(2) }))
          .sort((a, b) => b.net - a.net || b.targetQty - a.targetQty),
      })).sort((a, b) => b.repNet - a.repNet);
      if (!reps.length && viewer.mode === 'company') continue;
      out.push({ id: t.id, provinceId: t.provinceId, provinceName: t.provinceName, leaderName: t.leaderName, leaderRepId: repLink.get(t.leaderUserId) ?? null, reps });
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

    // الحقل نفسه personal لكن مصدره يختلف بنوع المندوب، ويوزَّع على شركاته بايتمات تعيينه:
    //  • العلمي: مبيعه في محافظة الفريق = «مبيعات المندوبين» المؤكدة + ميركاتو واللكوديشن باسمه.
    //  • المسوق: الجهد الشخصي المعتمد + «ملف الكوديشن» (بوت/إكسل).
    const repKinds = await prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, linkedRep: { select: { repKind: true } } } });
    const marketerIds = new Set(repKinds.filter(u => u.linkedRep?.repKind === PHARMACY_KIND).map(u => u.id));
    const liquidation = await loadTeamLiquidation(repIds, files, month, viewer.id);
    const sharedScopes = viewer.mode === 'company' ? (await loadSharedRepScopes(viewer.id)).byUser : new Map();
    const liquidationRows = (t, userId) => [...(liquidation.get(`${t.provinceName}|${userId}`)?.values() ?? [])]
      .filter(c => !sharedScopes.has(userId) || sharedScopes.get(userId).has(c.itemId))
      .map(c => ({ itemId: c.itemId, quantity: c.qty, valueUSD: c.usd, rows: c.rows, pharmacies: [...c.pharmacies] }));
    const pharmaciesOf = (rows) => new Set(rows.flatMap(x => x.pharmacies ?? [x.pharmacy]).filter(Boolean)).size;
    const rowCount = (rows) => rows.reduce((s2, x) => s2 + (x.rows ?? 1), 0);

    const condReps = new Map();
    for (const t of teams) for (const a of t.assignments) if (marketerIds.has(a.repUserId)) condReps.set(a.repUserId, { id: a.repUserId, name: a.repName });
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
          if (!marketerIds.has(a.repUserId)) {
            condLeft.set(a.repUserId, liquidationRows(t, a.repUserId));
          } else if (!conditionDone.has(a.repUserId)) {
            conditionDone.add(a.repUserId);
            condLeft.set(a.repUserId, [...(conditionByRep.get(a.repUserId) ?? [])]);
          }
        }
        const r = repsMap.get(a.repUserId);
        const c = cov.assignments.get(a.id);
        const base = (marketerIds.has(a.repUserId) && personalMap.get(`${a.repUserId}|${a.companyId}`)) || { valueUSD: 0, qty: 0, rows: 0, pharmacies: 0 };
        const p = { ...base };
        const left = condLeft.get(a.repUserId);
        if (left?.length) {
          const mine = left.filter(x => x.itemId && a.itemIds.includes(x.itemId));
          if (mine.length) {
            condLeft.set(a.repUserId, left.filter(x => !mine.includes(x)));
            p.valueUSD = +(p.valueUSD + mine.reduce((s2, x) => s2 + x.valueUSD, 0)).toFixed(2);
            p.qty += mine.reduce((s2, x) => s2 + x.quantity, 0);
            p.rows += rowCount(mine);
            p.pharmacies += pharmaciesOf(mine); // تقريبي: قد يتكرر اسم مع جهد شخصي معتمد
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
      // مبيع ايتم خارج تعييناته، أو صنف غير مطابَق بالكتالوج — يظهر على المندوب لا على شركة.
      for (const r of repsMap.values()) {
        let loose = marketerIds.has(r.repUserId) ? personalMap.get(`${r.repUserId}|0`) : undefined;
        const rest = condLeft.get(r.repUserId) ?? [];
        if (rest.length) {
          loose = { ...(loose ?? { valueUSD: 0, qty: 0, rows: 0, pharmacies: 0 }) };
          loose.valueUSD = +(loose.valueUSD + rest.reduce((s2, x) => s2 + x.valueUSD, 0)).toFixed(2);
          loose.qty += rest.reduce((s2, x) => s2 + x.quantity, 0);
          loose.rows += rowCount(rest);
          loose.pharmacies += pharmaciesOf(rest);
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

// ── ملاحظات المندوبين في جدول اللكوديشن (مثل «شمال بابل») ───────────────────
// تُكتب من السوبر أدمن (User.listNote) وتظهر للجميع. المفتاح = مفتاح سطر الجدول:
// u<userId> لمندوب فريق، r<repId> لسطر بلا حساب في فريق (المسوقون).
// GET /api/province-teams/rep-notes
export async function repNotes(req, res, next) {
  try {
    const users = await prisma.user.findMany({
      where: { listNote: { not: null } },
      select: { id: true, linkedRepId: true, listNote: true },
    });
    const notes = {};
    for (const u of users) {
      if (!u.listNote) continue;
      notes[`u${u.id}`] = u.listNote;
      if (u.linkedRepId) notes[`r${u.linkedRepId}`] = u.listNote;
    }
    res.json({ success: true, notes });
  } catch (e) { next(e); }
}
