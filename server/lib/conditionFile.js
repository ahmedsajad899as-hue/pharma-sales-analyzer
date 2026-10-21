// ════════════════════════════════════════════════════════════════════════════
// conditionFile.js — «ملف الكوديشن»: مبيعات المذاخر التي لا تأتي من إكسل
// ميركاتو نفسه — طلبيات بوت تلكرام/فايبر + إكسل الكوديشن (WarehouseGapImportModal).
//
// الملف حاوية تراكمية واحدة لكل (حساب × عملة) مصدرها 'mercato' — فكل مؤشرات
// ميركاتو (bySource.mercato، عدد الطلبيات، رصيد المذاخر…) تحتسبه بلا تعديل —
// لكنه UploadedFile مستقل فيُفعَّل/يُعطَّل وحده بجانب ملف ميركاتو. يُميَّز بلاحقة
// mergeGroup (راجع CONDITION_VARIANT في saleFingerprint.js).
//
// هنا: قراءة الملف «شيت لكل مندوب» (عرض داخل التطبيق + تصدير إكسل)، وترحيل
// طلبيات البوت/إكسل الكوديشن القديمة المحفوظة داخل ملفات ميركاتو إليه.
// ════════════════════════════════════════════════════════════════════════════

import XLSX from 'xlsx';
import prisma from './prisma.js';
import { CONDITION_VARIANT, fileVariant, fingerprintRows } from './saleFingerprint.js';
import { resolveCumulativeTarget, openMergeBatch, closeMergeBatch, refreshCumulativeFile, monthsLabelOf } from './cumulativeFile.js';
import { UNDATED_CUTOFF, buildMonthFilter } from './salesMonths.js';
import { repCoreName, buildRepIndex, matchRepName } from './repNameMatch.js';
import { getManagerRoster } from './managerRoster.js';
import { loadItemOwnerManagers } from './itemOwnerManager.js';
import { loadTransitSales, officeFileIdsOf } from './transitOrders.js';
import { areaIdsOfProvinces } from './areaScope.js';
import { normalizeArabic } from './itemResolver.js';

export const isConditionFile = (file) => fileVariant(file) === CONDITION_VARIANT;

/** مصادر rawData.source التي تخصّ ملف الكوديشن. */
const CONDITION_SOURCES = ['telegram-order', 'viber-order', 'warehouse-gap-template'];
const SOURCE_LABEL = {
  'telegram-order':         'بوت تلكرام',
  'viber-order':            'بوت فايبر',
  'warehouse-gap-template': 'إكسل الكوديشن',
  'manual-invoice':         'فاتورة يدوية',
};

const parseRaw = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const NO_REP = 'بلا مندوب';

/**
 * صفوف الملف مجمّعة حسب المندوب. المندوب = المندوب العلمي المختار عند مراجعة
 * الطلبية (rawData.scientificRep) وإلا مندوب الصف (إكسل الكوديشن يحمل عموداً له).
 * الصفوف المخفية (رفعة موقوفة/فلتر أعمدة) مستثناة — كما تراها التقارير.
 *
 * transit: طلبيات الترانزيت من ملفات المكتب المفعّلة (راجع transitSourceFiles)
 * تُضاف لشيت كل مندوب تخصّه بعلامة «ترانزيت» — للقراءة فقط، صفوفها في ملف المكتب.
 */
export async function loadConditionSheets(fileId, { month = null, transit = null } = {}) {
  const sales = await prisma.sale.findMany({
    where:   { uploadedFileId: fileId, isHidden: false, recordType: 'sale', ...buildMonthFilter(month) },
    orderBy: [{ saleDate: 'asc' }, { id: 'asc' }],
    select: {
      id: true, quantity: true, totalValue: true, saleDate: true, rawData: true,
      itemId: true, item: { select: { name: true, scientificCompanyId: true } }, area: { select: { name: true } },
      customer: { select: { name: true } }, representative: { select: { name: true } },
    },
  });

  const byRep = new Map();
  for (const s of sales) {
    const raw = parseRaw(s.rawData);
    const rep = repCoreName(String(raw.scientificRep || s.representative?.name || '').trim()) || NO_REP;
    const qty = Number(s.quantity) || 0;
    const total = Number(s.totalValue) || 0;
    const row = {
      id:        s.id,
      date:      s.saleDate && new Date(s.saleDate) >= UNDATED_CUTOFF ? new Date(s.saleDate).toISOString().slice(0, 10) : '',
      invoice:   String(raw.invoiceNumber ?? '').trim(),
      pharmacy:  String(raw.pharmacy || s.customer?.name || '').trim(),
      area:      s.area?.name && s.area.name !== 'غير محدد' ? s.area.name : '',
      warehouse: String(raw.warehouse ?? '').trim(),
      item:      s.item?.name ?? '',
      company:   String(raw.company ?? '').trim(),
      quantity:  qty,
      bonus:     Number(raw.bonus) || 0,
      unitPrice: Number(raw.unitPrice) || (qty ? Math.round((total / qty) * 100) / 100 : 0),
      total,
      source:    SOURCE_LABEL[raw.source] || '',
      rep,
      itemId:    s.itemId ?? null,
      sciCompanyId: s.item?.scientificCompanyId ?? null,
    };
    if (!byRep.has(rep)) byRep.set(rep, { rep, rows: [], quantity: 0, total: 0, orders: new Set() });
    const g = byRep.get(rep);
    g.rows.push(row);
    g.quantity += qty;
    g.total += total;
    g.orders.add(row.invoice || `${row.date}|${row.pharmacy}`);
  }

  if (transit?.officeFileIds?.length) {
    const transitRows = await loadTransitConditionRows(fileId, { month, ...transit });
    // نفس المندوب قد يُكتب في صفوف الكوديشن باسم أطول من اسم حسابه.
    const index = buildRepIndex([...byRep.keys()].filter(k => k !== NO_REP).map((k, i) => ({ id: i, name: k })));
    const keyOf = (name) => {
      if (byRep.has(name)) return name;
      const m = matchRepName(name, index);
      return m.status === 'exact' ? m.rep.name : name;
    };
    for (const { reps, row } of transitRows) {
      for (const name of reps.length ? reps : [NO_REP]) {
        const rep = keyOf(name);
        if (!byRep.has(rep)) byRep.set(rep, { rep, rows: [], quantity: 0, total: 0, orders: new Set() });
        const g = byRep.get(rep);
        g.rows.push({ ...row, rep });
        g.quantity += row.quantity;
        g.total += row.total;
        g.orders.add(row.invoice || `${row.date}|${row.pharmacy}`);
      }
    }
    for (const g of byRep.values()) g.rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
  }

  return [...byRep.values()]
    .map(g => ({ rep: g.rep, rows: g.rows, quantity: g.quantity, total: g.total, orders: g.orders.size }))
    .sort((a, b) => (a.rep === NO_REP) - (b.rep === NO_REP) || b.total - a.total);
}

// ── طلبيات الترانزيت (lib/transitOrders.js) داخل ملف الكوديشن ─────────────────

/** ملفات المكتب المفعّلة للمُشاهِد — مصدر الترانزيت — وكل ملفاته المفعّلة لبحث منطقة الصيدلية. */
export async function transitSourceFiles(viewerId) {
  if (!viewerId) return { officeFileIds: [], lookupFileIds: [] };
  const { resolveActiveFileIds } = await import('./activeFiles.js');
  const { ids } = await resolveActiveFileIds(viewerId);
  return { officeFileIds: await officeFileIdsOf(ids), lookupFileIds: ids };
}

/**
 * نطاق كل مندوب علمي (ومنهم التيم ليدر) له حساب في المكتب: أسماء مناطقه مطبَّعة
 * (مناطقه + مناطق محافظاته) وايتماته (resolveSciRepItemIds — نفس نطاق تقريره).
 */
async function loadOfficeRepScopes(officeId) {
  const users = await prisma.user.findMany({
    where:  { officeId, isActive: true, linkedRepId: { not: null } },
    select: { id: true, displayName: true, username: true, linkedRepId: true },
  });
  if (!users.length) return [];
  const repIds = [...new Set(users.map(u => u.linkedRepId))];
  const [areaLinks, provRows, allAreas] = await Promise.all([
    prisma.scientificRepArea.findMany({ where: { scientificRepId: { in: repIds } }, select: { scientificRepId: true, areaId: true } }),
    prisma.userProvinceAssignment.findMany({ where: { userId: { in: users.map(u => u.id) } }, select: { userId: true, provinceId: true } }),
    prisma.area.findMany({ select: { id: true, name: true } }),
  ]);
  const areaName = new Map(allAreas.map(a => [a.id, a.name]));
  const { resolveSciRepItemIds } = await import('../modules/scientific-reps/scientific-reps.service.js');
  const scopes = [];
  for (const repId of repIds) {
    const repUsers = users.filter(u => u.linkedRepId === repId);
    const userIds = new Set(repUsers.map(u => u.id));
    const provIds = [...new Set(provRows.filter(p => userIds.has(p.userId)).map(p => p.provinceId))];
    const areaIds = [
      ...areaLinks.filter(l => l.scientificRepId === repId).map(l => l.areaId),
      ...await areaIdsOfProvinces(provIds),
    ];
    const areaNorms = new Set(areaIds.map(id => areaName.get(id)).filter(Boolean).map(n => normalizeArabic(n)));
    if (!areaNorms.size) continue;
    const { itemIds } = await resolveSciRepItemIds(repId, repUsers.map(u => ({ id: u.id })));
    scopes.push({ name: repUsers[0].displayName || repUsers[0].username, areaNorms, itemIds: itemIds ? new Set(itemIds) : null });
  }
  return scopes;
}

const INVOICE_KEY_RE = /رقم\s*(ال)?(فاتور|طلب)|invoice/i;

/**
 * صفوف الترانزيت بشكل صفوف الكوديشن، كلٌّ مع أسماء المندوبين الذين تخصّهم:
 * منطقة الصيدلية ضمن مناطقه والايتم ضمن ايتماته. القيمة بعملة ملف الكوديشن.
 * @returns {Promise<Array<{reps:string[], row:object}>>}  reps فارغة = لم يُعرف لمن
 */
async function loadTransitConditionRows(fileId, { month, officeFileIds, lookupFileIds }) {
  const file = await prisma.uploadedFile.findUnique({
    where:  { id: fileId },
    select: { detectedCurrency: true, exchangeRate: true, user: { select: { officeId: true } } },
  });
  const officeId = file?.user?.officeId;
  if (!officeId) return [];
  const [sales, scopes] = await Promise.all([
    loadTransitSales({
      officeFileIds, lookupFileIds, where: buildMonthFilter(month),
      select: {
        quantity: true, totalValue: true, saleDate: true, itemId: true,
        item: { select: { name: true, scientificCompanyId: true, scientificCompany: { select: { name: true } }, company: { select: { name: true } } } },
        customer: { select: { name: true } },
        uploadedFile: { select: { detectedCurrency: true, exchangeRate: true } },
      },
    }),
    loadOfficeRepScopes(officeId),
  ]);
  if (!sales.length) return [];

  const { saleValueUSD } = await import('../modules/sales/sales.repository.js');
  const target = file.detectedCurrency || 'IQD';
  const inTarget = (s) => {
    if ((s.uploadedFile?.detectedCurrency || 'IQD') === target) return Number(s.totalValue) || 0;
    const usd = saleValueUSD(s);
    return target === 'IQD' ? usd * (file.exchangeRate || 1470) : usd;
  };

  return sales.map(s => {
    const t = s.transit;
    const raw = parseRaw(s.rawData);
    const invoiceKey = Object.keys(raw).find(k => INVOICE_KEY_RE.test(k));
    const qty = Number(s.quantity) || 0;
    const total = inTarget(s);
    const reps = t.areaNorm
      ? scopes.filter(r => r.areaNorms.has(t.areaNorm) && (!r.itemIds || r.itemIds.has(s.itemId))).map(r => repCoreName(r.name))
      : [];
    return {
      reps: [...new Set(reps)],
      row: {
        id:        s.id,
        date:      s.saleDate && new Date(s.saleDate) >= UNDATED_CUTOFF ? new Date(s.saleDate).toISOString().slice(0, 10) : '',
        invoice:   invoiceKey ? String(raw[invoiceKey] ?? '').trim() : '',
        pharmacy:  t.pharmacy,
        area:      t.areaName,
        warehouse: s.customer?.name ?? '',
        item:      s.item?.name ?? '',
        company:   s.item?.scientificCompany?.name || s.item?.company?.name || '',
        quantity:  qty,
        bonus:     0,
        unitPrice: qty ? Math.round((total / qty) * 100) / 100 : 0,
        total,
        source:    'ترانزيت',
        transit:   true,
        note:      t.note,
        itemId:    s.itemId ?? null,
        sciCompanyId: s.item?.scientificCompanyId ?? null,
      },
    };
  });
}

/** أدوار تُقيَّد رؤيتها بفريقها: لا ترى مبيعات مندوبي مدير آخر في الملف نفسه. */
const ROSTER_SCOPED_ROLES = new Set(['company_manager', 'team_leader', 'office_manager', 'office_employee', 'office_hr']);

/**
 * يُبقي شيتات مندوبي فريق المستخدم فقط. الملف قد يحمل مبيعات مندوبين تابعين
 * لمدير آخر في المكتب نفسه (طلبيات بوت/كوديشن مشتركة)، ولا يجوز أن تظهر عند
 * غيره. مطابقة الاسم كما في الباقي: تام/نواة، أو تشابه ≥0.7 بمرشّح واحد واضح.
 * «بلا مندوب» تُخفى عن هذه الأدوار أيضاً — لا تُنسب لفريقهم بدليل.
 */
export async function scopeSheetsToRoster(sheets, user) {
  if (!user || !ROSTER_SCOPED_ROLES.has(user.role)) return sheets;
  const roster = await getManagerRoster(user, { includeTeamLead: true });
  const index = buildRepIndex(roster.reps.map(r => ({ id: r.userId, name: r.name })));
  return sheets.filter(sh => {
    if (sh.rep === NO_REP) return false;
    const m = matchRepName(sh.rep, index);
    if (m.status === 'exact') return true;
    const top = m.suggestions[0], second = m.suggestions[1];
    return m.status === 'ask' && !!top && top.score >= 0.7 && (!second || top.score - second.score >= 0.15);
  });
}

export const COMPANY_SHEET = 'كل مبيعات الشركة';

/**
 * شيت «كل مبيعات الشركة» (طلب صاحب المشروع 2026-10-19): كل صفوف الملف التي تخصّ
 * شركة المستخدم **مهما كان المندوب** — ومنها «بلا مندوب» التي تُخفيها شيتات
 * المندوبين عن مدير الشركة (طلبية حُفظت بلا مندوب علمي لا تضيع عنه).
 *
 * «الشركة» = **التيم**: الايتمات المُسنَدة لمدير الشركة في «الايتمات» بالسوبر أدمن
 * (UserItemAssignment) — لا كل ايتمات الشركة العلمية (تعريف صاحب المشروع الصريح:
 * ايتم deva غير مُسنَد لمدير deva ليس من «شركة deva»). مدير الشركة: ايتماته المملوكة
 * بقاعدة التحليل الشامل (ايتم لمديرين يُحسب لواحد). غيره: ايتماته المُسنَدة له.
 * الأدوار غير المقيّدة بفريق ترى كل الصفوف. بلا أي إسناد: صفوف شيتاته الظاهرة فقط.
 *
 * @param {object[]} allSheets   ناتج loadConditionSheets قبل التقييد
 * @param {object[]} scoped      بعد scopeSheetsToRoster
 */
export async function buildCompanySheet(allSheets, scoped, user) {
  let rows;
  if (!user || !ROSTER_SCOPED_ROLES.has(user.role) || ['office_manager', 'office_employee', 'office_hr'].includes(user.role)) {
    rows = allSheets.flatMap(s => s.rows);
  } else {
    let itemIds;
    if (user.role === 'company_manager') {
      const me = await prisma.user.findUnique({ where: { id: user.id }, select: { officeId: true } });
      const owners = await loadItemOwnerManagers(me?.officeId ?? null);
      itemIds = new Set([...owners].filter(([, o]) => o.managerId === user.id).map(([id]) => id));
    }
    if (!itemIds?.size) {
      const items = await prisma.userItemAssignment.findMany({ where: { userId: user.id }, select: { itemId: true } });
      itemIds = new Set(items.map(i => i.itemId));
    }
    rows = itemIds.size
      ? allSheets.flatMap(s => s.rows).filter(r => itemIds.has(r.itemId))
      : scoped.flatMap(s => s.rows);
  }
  // صف ترانزيت يتكرّر في شيت كل مندوب يشترك في منطقته — يُعدّ هنا مرة واحدة.
  rows = [...new Map(rows.map(r => [r.id, r])).values()]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
  return {
    rep: COMPANY_SHEET, all: true, rows,
    quantity: rows.reduce((a, r) => a + r.quantity, 0),
    total: rows.reduce((a, r) => a + r.total, 0),
    orders: new Set(rows.map(r => r.invoice || `${r.date}|${r.pharmacy}`)).size,
  };
}

const COLUMNS = [
  ['date', 'التاريخ'], ['invoice', 'رقم الفاتورة'], ['pharmacy', 'الصيدلية'], ['area', 'المنطقة'],
  ['warehouse', 'المذخر'], ['item', 'الايتم'], ['company', 'الشركة'], ['quantity', 'الكمية'],
  ['bonus', 'البونص'], ['unitPrice', 'السعر'], ['total', 'القيمة'], ['source', 'المصدر'],
];

/** اسم شيت صالح وفريد: ≤31 حرفاً وبلا []:*?/\ */
function sheetName(name, used) {
  const base = String(name).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'مندوب';
  let n = base, i = 2;
  while (used.has(n)) n = `${base.slice(0, 26)} ${i++}`;
  used.add(n);
  return n;
}

/** إكسل: شيت ملخّص + شيت لكل مندوب بمبيعاته. */
export function buildConditionWorkbook(sheets, { title = 'ملف الكوديشن', companySheet = null } = {}) {
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  const used = new Set();

  const summary = [
    [title],
    [],
    ['المندوب', 'عدد الطلبيات', 'عدد الصفوف', 'الكمية', 'القيمة'],
    ...sheets.map(s => [s.rep, s.orders, s.rows.length, s.quantity, s.total]),
    ['المجموع',
      sheets.reduce((a, s) => a + s.orders, 0), sheets.reduce((a, s) => a + s.rows.length, 0),
      sheets.reduce((a, s) => a + s.quantity, 0), sheets.reduce((a, s) => a + s.total, 0)],
  ];
  const ws0 = XLSX.utils.aoa_to_sheet(summary);
  ws0['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];
  ws0['!views'] = [{ RTL: true }];
  XLSX.utils.book_append_sheet(wb, ws0, sheetName('الملخص', used));

  for (const s of (companySheet ? [companySheet, ...sheets] : sheets)) {
    // شيت الشركة يحمل عمود المندوب (صفوفه من كل المندوبين).
    const cols = s.all ? [...COLUMNS.slice(0, 7), ['rep', 'المندوب'], ...COLUMNS.slice(7)] : COLUMNS;
    const aoa = [
      cols.map(c => c[1]),
      ...s.rows.map(r => cols.map(([k]) => r[k] ?? '')),
      cols.map(([k]) => (k === 'date' ? 'المجموع' : k === 'quantity' ? s.quantity : k === 'total' ? s.total : '')),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = cols.map(([k]) => ({ wch: ['pharmacy', 'item', 'warehouse', 'rep'].includes(k) ? 26 : 13 }));
    ws['!views'] = [{ RTL: true }];
    XLSX.utils.book_append_sheet(wb, ws, sheetName(s.rep, used));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ════════════════════════════════════════════════════════════════════════════
// ترحيل: قبل هذه الميزة كانت طلبيات البوت وإكسل الكوديشن تُحفَظ داخل ملفات
// ميركاتو. تُنقَل صفوفها الظاهرة إلى ملف الكوديشن (نفس الحساب ونفس العملة) —
// والمخفية تُترك مكانها (رفعة موقوفة/فلتر: نقلها كان سيُظهرها أو يُضيّع سببها).
// idempotent: بعد أول مرة لا تبقى صفوف بهذه المصادر خارج ملف الكوديشن.
// إجمالي ميركاتو لا يتغيّر: الصفوف نفسها، بمصدر 'mercato' نفسه، في ملف شقيق.
// ════════════════════════════════════════════════════════════════════════════

const SOURCE_FILTERS = CONDITION_SOURCES.map(v => ({ rawData: { contains: `"source":"${v}"` } }));

export async function migrateRowsToConditionFiles() {
  const hits = await prisma.sale.findMany({
    where:    { isHidden: false, OR: SOURCE_FILTERS, uploadedFile: { sourceSystem: 'mercato' } },
    select:   { uploadedFileId: true },
    distinct: ['uploadedFileId'],
  });
  const fileIds = hits.map(h => h.uploadedFileId).filter(Boolean);
  if (!fileIds.length) return 0;
  const files = (await prisma.uploadedFile.findMany({ where: { id: { in: fileIds } } }))
    .filter(f => f.userId && !isConditionFile(f));

  let moved = 0;
  for (const file of files) {
    try { moved += await moveFileConditionRows(file); }
    catch (e) { console.error(`[conditionFile] ترحيل الملف #${file.id} فشل:`, e.message); }
  }
  return moved;
}

async function moveFileConditionRows(file) {
  const rows = (await prisma.sale.findMany({
    where:   { uploadedFileId: file.id, isHidden: false, OR: SOURCE_FILTERS },
    orderBy: { id: 'asc' },
    select:  { id: true, rawData: true, itemId: true, customerId: true, recordType: true, quantity: true, totalValue: true, saleDate: true, mergeBatchId: true },
  })).filter(r => CONDITION_SOURCES.includes(parseRaw(r.rawData).source));
  if (!rows.length) return 0;

  const { file: target } = await resolveCumulativeTarget({
    userId: file.userId, sourceSystem: 'mercato', detectedCurrency: file.detectedCurrency || 'IQD', variant: CONDITION_VARIANT,
  });
  const batch = await openMergeBatch({ fileId: target.id, originalName: `منقول من «${file.originalName}»`, fileType: 'sales' });

  const keys = fingerprintRows(rows);
  const existing = new Set((await prisma.sale.findMany({
    where: { uploadedFileId: target.id, dedupKey: { in: keys } }, select: { dedupKey: true },
  })).map(r => r.dedupKey));

  const dupIds = [];
  const moves = [];
  rows.forEach((r, i) => (existing.has(keys[i]) ? dupIds.push(r.id) : moves.push({ id: r.id, key: keys[i] })));
  for (let i = 0; i < moves.length; i += 200) {
    await prisma.$transaction(moves.slice(i, i + 200).map(m => prisma.sale.update({
      where: { id: m.id },
      data:  { uploadedFileId: target.id, dedupKey: m.key, mergeBatchId: batch.id },
    })));
  }
  if (dupIds.length) await prisma.sale.deleteMany({ where: { id: { in: dupIds } } });

  await closeMergeBatch(batch.id, {
    rowsAdded: moves.length, rowsSkipped: dupIds.length, monthsLabel: monthsLabelOf(rows.map(r => r.saleDate)),
  });
  await refreshCumulativeFile(target.id);

  // المصدر: رفعات «إدخال يدوي» التي فرغت تُحذف، والعدّ يُصحَّح، والملف الذي لم
  // يبقَ فيه شيء (ملف إكسل كوديشن مستقل قديم) يُحذف.
  const batchIds = [...new Set(rows.map(r => r.mergeBatchId).filter(Boolean))];
  for (const bid of batchIds) {
    const left = await prisma.sale.count({ where: { uploadedFileId: file.id, mergeBatchId: bid } });
    if (left === 0) await prisma.fileMergeBatch.deleteMany({ where: { id: bid, fileId: file.id } });
  }
  const remaining = await prisma.sale.count({ where: { uploadedFileId: file.id } });
  if (remaining === 0 && !file.isCumulative) {
    await prisma.uploadedFile.delete({ where: { id: file.id } }).catch(() => {});
  } else if (file.isCumulative) {
    await refreshCumulativeFile(file.id);
  } else {
    await prisma.uploadedFile.update({ where: { id: file.id }, data: { rowCount: remaining } });
  }
  console.log(`[conditionFile] #${file.id} → كوديشن #${target.id}: نُقل ${moves.length}، مكرر ${dupIds.length}`);
  return moves.length;
}

/**
 * مبيعات الكوديشن منسوبةً لمندوبي المحافظات (حساب مستخدم) — تُعرض كـ«مبيع شخصي».
 * الكوديشن مصدره ميركاتو فلا تدخل تغطية المحافظة (تستثني ميركاتو) ولا تُعدّ مرتين.
 * المندوب في الصف = المندوب العلمي المختار (rawData.scientificRep) وإلا مندوب
 * الصف؛ يُطابَق باسم حساب المندوب: تام/نواة، أو تشابه ≥0.7 بمرشّح واضح.
 * الملفات المقروءة: ملفات الكوديشن لحسابات المكاتب المعنيّة فقط.
 *
 * @param {{id:number,name:string}[]} reps  حسابات مندوبي المحافظات
 * @param {{month?:string, officeIds?:number[]}} opts
 * @returns {Promise<Map<number, Array<{itemId:number|null,itemName:string,quantity:number,valueUSD:number,pharmacy:string}>>>}
 */
export async function loadConditionSalesForReps(reps, { month = 'all', officeIds = [] } = {}) {
  const out = new Map();
  if (!reps.length) return out;
  const owners = officeIds.length
    ? (await prisma.user.findMany({ where: { officeId: { in: officeIds } }, select: { id: true } })).map(u => u.id)
    : [];
  if (!owners.length) return out;
  const files = await prisma.uploadedFile.findMany({
    where: { userId: { in: owners }, mergeGroup: { endsWith: `|${CONDITION_VARIANT}` } },
    select: { id: true },
  });
  if (!files.length) return out;

  const { saleValueUSD } = await import('../modules/sales/sales.repository.js');
  const sales = await prisma.sale.findMany({
    where: { uploadedFileId: { in: files.map(f => f.id) }, isHidden: false, recordType: 'sale', ...buildMonthFilter(month) },
    select: {
      itemId: true, quantity: true, totalValue: true, rawData: true,
      item: { select: { name: true } }, customer: { select: { name: true } },
      representative: { select: { name: true } },
      uploadedFile: { select: { detectedCurrency: true, exchangeRate: true } },
    },
  });

  const index = buildRepIndex(reps);
  const cache = new Map();
  const resolve = (name) => {
    if (cache.has(name)) return cache.get(name);
    const m = matchRepName(name, index);
    let id = null;
    if (m.status === 'exact') id = m.rep.id;
    else if (m.status === 'ask' && m.suggestions[0]?.score >= 0.7
      && (!m.suggestions[1] || m.suggestions[0].score - m.suggestions[1].score >= 0.15)) id = m.suggestions[0].id;
    cache.set(name, id);
    return id;
  };
  for (const s of sales) {
    const raw = parseRaw(s.rawData);
    const name = String(raw.scientificRep || s.representative?.name || '').trim();
    if (!name) continue;
    const repId = resolve(name);
    if (!repId) continue;
    if (!out.has(repId)) out.set(repId, []);
    out.get(repId).push({
      itemId: s.itemId ?? null,
      itemName: s.item?.name ?? `#${s.itemId}`,
      quantity: Number(s.quantity) || 0,
      valueUSD: saleValueUSD(s),
      pharmacy: String(raw.pharmacy || s.customer?.name || '').trim(),
    });
  }
  return out;
}
