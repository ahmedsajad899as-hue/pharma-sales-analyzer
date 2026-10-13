// ════════════════════════════════════════════════════════════════════════════
// province-coverage.js — «تغطية المحافظة»: الحسبة الأولى لمندوب المحافظة.
//
// كل مبيع (مبيع − إرجاع) لايتمات المندوب داخل محافظته يُحتسب له، من المكتب إلى
// المذاخر أو الصيدليات، بصرف النظر عن المندوب التجاري الذي سجّله.
//
// قرارات مقصودة:
//  • المحافظة تُحسم بنفس أولوية تبويب «المحافظة» في التحليل الشامل
//    (reports.routes.js): محافظة المنطقة المعتمدة من السوبر أدمن أولاً، ثم عمود
//    المحافظة في الإكسل للمناطق غير المصنّفة. رقمان مختلفان لنفس المحافظة في
//    شاشتين = خطأ في إحداهما.
//  • ملفات ميركاتو مستبعدة: هي بيع المذاخر للصيدليات (حركة لاحقة لنفس البضاعة)،
//    وجمعها مع ملف المكتب يعدّ البضاعة مرتين.
//  • الجهد الشخصي لا يُجمع هنا أبداً — مؤشّر مستقل (قرار المستخدم).
//  • القيم مُطبَّعة للدولار (saleValueUSD) كباقي التقارير متعددة الملفات؛ الواجهة
//    تعرضها بعملة الملفات.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { saleValueUSD } from '../sales/sales.repository.js';
import { PROVINCE_COLUMN_ALIASES, extractRawColumnValue, buildProvinceLookup, matchProvinceName } from '../../lib/provinces.js';
import { isWarehouseSaleRow, pharmacyNameFromRawData, orderKeyFromRawData } from '../../lib/orderKey.js';
import { buildMonthFilter, listSalesMonths } from '../../lib/salesMonths.js';
import { resolveActiveFileIds } from '../../lib/activeFiles.js';
import { expandOwnerIdsByCompany } from '../scientific-reps/scientific-reps.service.js';
import { buildItemAttribution, classifyChannel } from './province-teams.rules.js';
import { loadCompanyItems } from './province-teams.service.js';

const DEFAULT_RATE = 1470;

// ─── الملفات ──────────────────────────────────────────────────────────────────

/**
 * الملفات التي تُحسب عليها التغطية.
 * المُشاهِد الذي يملك ملفات مفعّلة يُحسب على ملفاته (ما يراه في كل التطبيق).
 * القائد والمندوب في المحافظات غالباً بلا ملفات أصلاً — فيُحسب لهم على الملفات
 * المفعّلة لدى إدارة مكتبهم (User.activeFileIds المُزامَنة من المتصفح)، وإلا
 * لظهرت أرقامهم صفراً دائماً.
 */
export async function resolveCoverageFiles(viewer, requested) {
  const ids = String(requested ?? '').split(',').map(Number).filter(Number.isInteger);
  let fileIds = [];
  let source = 'الملفات المفعّلة';

  if (ids.length) {
    const ownerIds = await expandOwnerIdsByCompany([viewer.id]);
    const ok = await prisma.uploadedFile.findMany({
      where: { id: { in: ids }, OR: [{ userId: { in: ownerIds } }, { fileShares: { some: { userId: viewer.id } } }] },
      select: { id: true },
    });
    fileIds = ok.map(f => f.id);
  }

  if (!fileIds.length && viewer.officeId) {
    const holders = await prisma.user.findMany({
      where: { officeId: viewer.officeId, isActive: true, role: { in: ['office_manager', 'office_employee', 'office_hr'] }, activeFileIds: { not: null } },
      select: { id: true, role: true, displayName: true, username: true },
    });
    // مدير المكتب أولاً — ملفاته المفعّلة هي المرجع الرسمي للمكتب.
    holders.sort((a, b) => (a.role === 'office_manager' ? 0 : 1) - (b.role === 'office_manager' ? 0 : 1));
    for (const h of holders) {
      const r = await resolveActiveFileIds(h.id);
      if (r.synced && r.ids.length) {
        fileIds = r.ids;
        source = `ملفات المكتب المفعّلة (${h.displayName || h.username})`;
        break;
      }
    }
  }

  const files = fileIds.length
    ? await prisma.uploadedFile.findMany({
        where: { id: { in: fileIds } },
        select: { id: true, originalName: true, sourceSystem: true, detectedCurrency: true, exchangeRate: true },
      })
    : [];
  const officeFiles = files.filter(f => f.sourceSystem !== 'mercato');
  // عملة العرض = عملة أغلب الملفات؛ والسعر من أول ملف بالدينار.
  const iqd = officeFiles.filter(f => f.detectedCurrency !== 'USD');
  const currency = iqd.length >= officeFiles.length - iqd.length ? 'IQD' : 'USD';
  const rate = iqd[0]?.exchangeRate || DEFAULT_RATE;

  return {
    fileIds: officeFiles.map(f => f.id),
    names: officeFiles.map(f => f.originalName),
    excludedMercato: files.length - officeFiles.length,
    source: officeFiles.length ? source : 'لا توجد ملفات مبيعات مفعّلة',
    currency,
    rate,
  };
}

export async function listCoverageMonths(fileIds) {
  return listSalesMonths(prisma, fileIds);
}

// ─── الحساب ───────────────────────────────────────────────────────────────────

const emptyStats = () => ({
  salesValue: 0, returnValue: 0, net: 0, netQty: 0,
  warehouseNet: 0, pharmacyNet: 0,
  orderKeys: new Set(), unkeyedOrders: 0, customers: new Set(),
  byItem: new Map(), byArea: new Map(), byCustomer: new Map(),
});

function addRow(st, row) {
  const v = row.value;
  const signed = row.isReturn ? -v : v;
  const signedQty = row.isReturn ? -row.qty : row.qty;
  if (row.isReturn) st.returnValue += v; else st.salesValue += v;
  st.net += signed;
  st.netQty += signedQty;
  if (row.channel === 'warehouse') st.warehouseNet += signed; else st.pharmacyNet += signed;
  if (!row.isReturn) {
    if (row.orderKey) st.orderKeys.add(row.orderKey); else st.unkeyedOrders++;
    if (row.customer) st.customers.add(row.customer);
  }
  const bump = (map, key, name, extra = {}) => {
    if (!map.has(key)) map.set(key, { name, net: 0, qty: 0, ...extra });
    const e = map.get(key); e.net += signed; e.qty += signedQty;
  };
  bump(st.byItem, row.itemId, row.itemName, { itemId: row.itemId });
  bump(st.byArea, row.areaName || '—', row.areaName || '—');
  if (row.customer) bump(st.byCustomer, row.customer, row.customer, { channel: row.channel });
}

const r2 = (n) => +Number(n || 0).toFixed(2);
const top = (map, n) => [...map.values()].sort((a, b) => b.net - a.net).slice(0, n).map(e => ({ ...e, net: r2(e.net) }));

function finalize(st, { itemLimit = 200, areaLimit = 50, customerLimit = 15 } = {}) {
  return {
    salesValue: r2(st.salesValue),
    returnValue: r2(st.returnValue),
    net: r2(st.net),
    netQty: st.netQty,
    warehouseNet: r2(st.warehouseNet),
    pharmacyNet: r2(st.pharmacyNet),
    orders: st.orderKeys.size + st.unkeyedOrders,
    customers: st.customers.size,
    byItem: top(st.byItem, itemLimit),
    byArea: top(st.byArea, areaLimit),
    topCustomers: top(st.byCustomer, customerLimit),
  };
}

/**
 * @param {Array} teams ناتج loadVisibleTeams
 * @param {{fileIds:number[], month:string}} opts
 */
export async function computeCoverage(teams, { fileIds, month }) {
  const result = new Map(); // teamId → { team, assignments: Map, uncovered: Map }
  if (!teams.length || !fileIds.length) {
    for (const t of teams) result.set(t.id, { team: emptyStats(), assignments: new Map(), uncovered: new Map(), overlaps: [] });
    return serialize(teams, result);
  }

  // شركات كل الفرق → ايتمات الكتالوج (لـ«كل الايتمات» ولسلّة غير المنسوب).
  const companyIds = [...new Set(teams.flatMap(t => t.allAssignments.map(a => a.companyId)))];
  const companyItems = await loadCompanyItems(companyIds);
  const itemCompany = new Map();
  for (const [cid, ids] of companyItems) for (const id of ids) itemCompany.set(id, cid);
  // ايتمات معيَّنة يدوياً قد لا تكون في كتالوج شركتها بعد (نُقلت لاحقاً) — تُضمّ.
  for (const t of teams) for (const a of t.allAssignments) for (const id of a.itemIds) if (!itemCompany.has(id)) itemCompany.set(id, a.companyId);

  const perTeam = teams.map(t => {
    const { owner, overlaps } = buildItemAttribution(t.allAssignments, companyItems);
    return { t, owner, overlaps, teamCompanies: new Set(t.allAssignments.map(a => a.companyId)) };
  });

  const provinceRows = await prisma.province.findMany({ select: { id: true, name: true, aliases: true } });
  const lookup = buildProvinceLookup(provinceRows);
  const teamsByProvince = new Map();
  for (const p of perTeam) {
    if (!teamsByProvince.has(p.t.provinceId)) teamsByProvince.set(p.t.provinceId, []);
    teamsByProvince.get(p.t.provinceId).push(p);
  }
  const provinceIds = [...teamsByProvince.keys()];

  const itemUniverse = [...itemCompany.keys()];
  if (!itemUniverse.length) {
    for (const t of teams) result.set(t.id, { team: emptyStats(), assignments: new Map(), uncovered: new Map(), overlaps: [] });
    return serialize(teams, result);
  }

  // قاعدة البيانات تُضيّق أولاً: مناطق المحافظات المطلوبة، أو مناطق بلا محافظة
  // بعد (هذه وحدها تحتاج قراءة عمود المحافظة من الإكسل).
  const sales = await prisma.sale.findMany({
    where: {
      uploadedFileId: { in: fileIds },
      isHidden: false,
      itemId: { in: itemUniverse },
      ...buildMonthFilter(month),
      OR: [{ area: { provinceId: { in: provinceIds } } }, { area: { provinceId: null } }],
    },
    select: {
      itemId: true, quantity: true, totalValue: true, recordType: true, rawData: true,
      item: { select: { name: true } },
      area: { select: { name: true, provinceId: true } },
      uploadedFile: { select: { detectedCurrency: true, exchangeRate: true } },
    },
  });

  for (const p of perTeam) {
    result.set(p.t.id, { team: emptyStats(), assignments: new Map(p.t.allAssignments.map(a => [a.id, emptyStats()])), uncovered: new Map(), overlaps: p.overlaps });
  }

  for (const s of sales) {
    let provinceId = s.area?.provinceId ?? null;
    if (!provinceId) {
      let raw = null;
      try { raw = s.rawData ? JSON.parse(s.rawData) : null; } catch { raw = null; }
      const rawProv = raw ? extractRawColumnValue(raw, PROVINCE_COLUMN_ALIASES) : null;
      provinceId = rawProv ? (matchProvinceName(rawProv, lookup)?.id ?? null) : null;
    }
    const group = provinceId ? teamsByProvince.get(provinceId) : null;
    if (!group) continue;

    const customer = pharmacyNameFromRawData(s.rawData) || '';
    const row = {
      itemId: s.itemId,
      itemName: s.item?.name ?? `#${s.itemId}`,
      areaName: s.area?.name ?? null,
      qty: Number(s.quantity) || 0,
      value: saleValueUSD(s),
      isReturn: s.recordType === 'return',
      channel: classifyChannel(isWarehouseSaleRow(s.rawData), customer),
      customer: customer.trim() || null,
      orderKey: orderKeyFromRawData(s.rawData),
    };
    const companyId = itemCompany.get(s.itemId);

    for (const p of group) {
      // ايتم شركة لا تعمل في هذا الفريق لا يخصّه أصلاً.
      if (!p.teamCompanies.has(companyId)) continue;
      const bucket = result.get(p.t.id);
      addRow(bucket.team, row);
      const aid = p.owner.get(s.itemId);
      if (aid) {
        addRow(bucket.assignments.get(aid), row);
      } else {
        if (!bucket.uncovered.has(companyId)) bucket.uncovered.set(companyId, emptyStats());
        addRow(bucket.uncovered.get(companyId), row);
      }
    }
  }

  return serialize(teams, result);
}

function serialize(teams, result) {
  const out = new Map();
  for (const t of teams) {
    const b = result.get(t.id);
    const companyName = new Map(t.allAssignments.map(a => [a.companyId, a.companyName]));
    out.set(t.id, {
      totals: finalize(b.team, { itemLimit: 30, areaLimit: 30 }),
      assignments: new Map([...b.assignments].map(([id, st]) => [id, finalize(st)])),
      uncovered: [...b.uncovered].map(([companyId, st]) => {
        const f = finalize(st, { itemLimit: 10, areaLimit: 5, customerLimit: 5 });
        return { companyId, companyName: companyName.get(companyId) ?? '—', net: f.net, netQty: f.netQty, topItems: f.byItem };
      }).filter(u => Math.abs(u.net) > 0.005 || u.netQty !== 0).sort((a, b) => b.net - a.net),
      overlaps: b.overlaps,
    });
  }
  return out;
}
