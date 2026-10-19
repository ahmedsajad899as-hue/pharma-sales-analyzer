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
 */
export async function loadConditionSheets(fileId, { month = null } = {}) {
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

  return [...byRep.values()]
    .map(g => ({ rep: g.rep, rows: g.rows, quantity: g.quantity, total: g.total, orders: g.orders.size }))
    .sort((a, b) => (a.rep === NO_REP) - (b.rep === NO_REP) || b.total - a.total);
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
  rows = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
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
