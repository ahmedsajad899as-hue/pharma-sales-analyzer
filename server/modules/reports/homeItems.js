// ════════════════════════════════════════════════════════════════════════════
// homeItems.js — بيانات الصفحة «الرئيسية»: مبيع/إرجاع كل ايتم شهراً بشهر،
// وتفصيل ايتم واحد على المحافظات.
//
// التجميع يتم في Postgres (GROUP BY ايتم × ملف × نوع × شهر [× منطقة]) لا بجلب
// الصفوف: الملف التراكمي يحمل مئات آلاف الصفوف وRAM السيرفر 951MB.
// الملف داخل GROUP BY لأن العملة لكل ملف — القيمة تُطبَّع إلى USD بعد التجميع
// بنفس قاعدة saleValueUSD (الواجهة تعامل القيم كـUSD وتحوّلها للعرض فقط).
//
// النطاق = نفس قواعد /api/reports/overall:
//   • الملفات المطلوبة يُتحقَّق منها (مالك أو مُشارَك معه — fileScope.js).
//   • مصدر واحد لا خلط: المكتب افتراضياً، وإلا ميركاتو (مثل ReportsPage).
//   • نطاق ايتمات المستخدم (UserItemAssignment) — يشمل مدير الشركة هنا خلافاً
//     لـ/overall (طلب صريح: يرى ايتماته فقط لا كل ايتمات المكتب). مدير شركة بلا
//     ايتمات مُسنَدة لا يرى شيئاً (noItems) — ايتم غير مُسنَد لا يُحتسب لأي تيم.
//   • نطاق المناطق على الملفات المُشارَكة — مدير الشركة مُستثنى منه كما في /overall.
//   • حارس «بلا تاريخ» لكل ملف: التراكمي بحدّ UNDATED_CUTOFF، والمستقل بما قبل
//     لحظة رفعه (إن وُجد فيه صفّ مؤرَّخ أصلاً).
// ════════════════════════════════════════════════════════════════════════════

import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { resolveEffectiveAreaIds } from '../../lib/areaScope.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';
import { UNDATED_CUTOFF } from '../../lib/salesMonths.js';

const UNKNOWN_PROVINCE = 'غير محدد';
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @returns {Promise<null | { files, sources, source, conds: Prisma.Sql[], rateByFile: Map }>}
 *   null = لا ملفات صالحة (الواجهة تعرض حالة فارغة).
 */
async function resolveHomeScope(user, fileIdsParam, sourceParam) {
  const userId = user?.id ?? null;
  const ids = String(fileIdsParam ?? '').split(',').map(Number).filter(Number.isInteger).filter(n => n > 0);
  if (!userId || ids.length === 0) return null;

  const accessible = await prisma.uploadedFile.findMany({
    where: { id: { in: ids }, OR: [{ userId }, { fileShares: { some: { userId } } }] },
    select: {
      id: true, userId: true, originalName: true, filename: true, sourceSystem: true,
      detectedCurrency: true, exchangeRate: true, currencyMode: true,
      isCumulative: true, uploadedAt: true,
    },
  });
  if (accessible.length === 0) return null;

  const isMercato = (f) => f.sourceSystem === 'mercato';
  const sources = [];
  if (accessible.some(f => !isMercato(f))) sources.push('office');
  if (accessible.some(isMercato)) sources.push('mercato');
  const source = sources.includes(sourceParam) ? sourceParam : sources[0];
  const files = accessible.filter(f => (source === 'mercato') === isMercato(f));

  const isCompanyManager = user.role === 'company_manager';
  const scopedItemIds = await resolveEffectiveItemIds(userId); // null = بلا تقييد
  if (isCompanyManager && scopedItemIds == null) return { noItems: true };
  const conds = [
    Prisma.sql`s."isHidden" = false`,
    Prisma.sql`s."uploadedFileId" IN (${Prisma.join(files.map(f => f.id))})`,
  ];

  if (Array.isArray(scopedItemIds)) {
    conds.push(scopedItemIds.length ? Prisma.sql`s."itemId" IN (${Prisma.join(scopedItemIds)})` : Prisma.sql`FALSE`);
  }
  if (!isCompanyManager) {
    if (files.some(f => f.userId !== userId)) {
      const areaIds = await resolveEffectiveAreaIds(userId);
      if (areaIds.length > 0) conds.push(Prisma.sql`s."areaId" IN (${Prisma.join(areaIds)})`);
    }
  }

  // حارس «بلا تاريخ» — فرع لكل ملف
  const fileConds = [];
  for (const f of files) {
    if (f.isCumulative || !f.uploadedAt) {
      fileConds.push(Prisma.sql`(s."uploadedFileId" = ${f.id} AND s."saleDate" >= ${UNDATED_CUTOFF})`);
      continue;
    }
    const realCount = await prisma.sale.count({
      where: { uploadedFileId: f.id, isHidden: false, saleDate: { lt: f.uploadedAt, gte: UNDATED_CUTOFF } },
    });
    fileConds.push(realCount > 0
      ? Prisma.sql`(s."uploadedFileId" = ${f.id} AND s."saleDate" >= ${UNDATED_CUTOFF} AND s."saleDate" < ${f.uploadedAt})`
      : Prisma.sql`(s."uploadedFileId" = ${f.id} AND s."saleDate" >= ${UNDATED_CUTOFF})`);
  }
  conds.push(Prisma.sql`(${Prisma.join(fileConds, ' OR ')})`);

  const rateByFile = new Map(files.map(f => [f.id, f.detectedCurrency === 'IQD' ? (f.exchangeRate || 1470) : 1]));
  return { files, sources, source, conds, rateByFile };
}

const fileMeta = (scope) => ({
  sources: scope.sources,
  source: scope.source,
  files: scope.files.map(f => ({ id: f.id, name: f.originalName || f.filename })),
  currencyMode: scope.files.find(f => f.currencyMode)?.currencyMode === 'USD' ? 'USD' : 'IQD',
  exchangeRate: scope.files.find(f => f.exchangeRate)?.exchangeRate || 1470,
});

/** الصفوف المجمّعة: [مبيع كمية، مبيع قيمة USD، إرجاع كمية، إرجاع قيمة USD] */
function addRow(target, row, rate) {
  const q = Number(row.qty) || 0;
  const v = (Number(row.val) || 0) / rate;
  if (row.recordType === 'return') { target[2] += Math.abs(q); target[3] += Math.abs(v); }
  else { target[0] += q; target[1] += v; }
}
const roundCell = (c) => [Math.round(c[0]), r2(c[1]), Math.round(c[2]), r2(c[3])];

/**
 * GET /api/reports/home-items?fileIds=1,2&source=office|mercato
 * → { months, items: [{ id, name, company, m: { 'YYYY-MM': [sq, sv, rq, rv] } }], ...fileMeta }
 */
export async function getHomeItems(req, res) {
  try {
    const scope = await resolveHomeScope(req.user, req.query.fileIds, req.query.source);
    if (!scope) return res.json({ success: true, data: { months: [], items: [], sources: [], files: [] } });
    if (scope.noItems) return res.json({ success: true, data: { months: [], items: [], sources: [], files: [], noItems: true } });

    const rows = await prisma.$queryRaw`
      SELECT s."itemId" AS "itemId", s."uploadedFileId" AS "fileId", s."recordType" AS "recordType",
             to_char(date_trunc('month', s."saleDate" AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             SUM(s.quantity)::float AS qty, SUM(s."totalValue")::float AS val
        FROM sales s
       WHERE ${Prisma.join(scope.conds, ' AND ')}
       GROUP BY 1, 2, 3, 4`;

    const byItem = new Map();
    const monthSet = new Set();
    for (const row of rows) {
      monthSet.add(row.ym);
      if (!byItem.has(row.itemId)) byItem.set(row.itemId, {});
      const m = byItem.get(row.itemId);
      if (!m[row.ym]) m[row.ym] = [0, 0, 0, 0];
      addRow(m[row.ym], row, scope.rateByFile.get(row.fileId) || 1);
    }

    const itemRecs = byItem.size ? await prisma.item.findMany({
      where: { id: { in: [...byItem.keys()] } },
      select: { id: true, name: true, company: { select: { name: true } }, scientificCompany: { select: { name: true } } },
    }) : [];
    const items = itemRecs.map(it => {
      const m = byItem.get(it.id);
      for (const k of Object.keys(m)) m[k] = roundCell(m[k]);
      return { id: it.id, name: it.name, company: it.scientificCompany?.name ?? it.company?.name ?? null, m };
    });

    res.json({ success: true, data: { months: [...monthSet].sort(), items, ...fileMeta(scope) } });
  } catch (err) {
    console.error('[home-items]', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/reports/home-items/:itemId/provinces?fileIds=…&source=…
 * → { provinces: [{ name, m: { 'YYYY-MM': [sq, sv, rq, rv] } }] }
 * المحافظة = Area.province (تصنيف السوبر أدمن الرسمي، كتبويب المحافظة في التحليل الشامل).
 */
export async function getHomeItemProvinces(req, res) {
  try {
    const itemId = Number(req.params.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: 'itemId غير صالح' });
    const scope = await resolveHomeScope(req.user, req.query.fileIds, req.query.source);
    if (!scope || scope.noItems) return res.json({ success: true, data: { provinces: [] } });

    const rows = await prisma.$queryRaw`
      SELECT p.name AS province, s."uploadedFileId" AS "fileId", s."recordType" AS "recordType",
             to_char(date_trunc('month', s."saleDate" AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             SUM(s.quantity)::float AS qty, SUM(s."totalValue")::float AS val
        FROM sales s
        LEFT JOIN areas a ON a.id = s."areaId"
        LEFT JOIN provinces p ON p.id = a."provinceId"
       WHERE s."itemId" = ${itemId} AND ${Prisma.join(scope.conds, ' AND ')}
       GROUP BY 1, 2, 3, 4`;

    const byProv = new Map();
    for (const row of rows) {
      const name = row.province || UNKNOWN_PROVINCE;
      if (!byProv.has(name)) byProv.set(name, {});
      const m = byProv.get(name);
      if (!m[row.ym]) m[row.ym] = [0, 0, 0, 0];
      addRow(m[row.ym], row, scope.rateByFile.get(row.fileId) || 1);
    }
    // كل محافظات السوبر أدمن تُعرض حتى بلا مبيع ولا إرجاع (صفر) — طلب صريح
    for (const p of await prisma.province.findMany({ select: { name: true } })) {
      if (!byProv.has(p.name)) byProv.set(p.name, {});
    }
    const provinces = [...byProv.entries()].map(([name, m]) => {
      for (const k of Object.keys(m)) m[k] = roundCell(m[k]);
      return { name, m };
    });
    res.json({ success: true, data: { provinces } });
  } catch (err) {
    console.error('[home-items/provinces]', err);
    res.status(500).json({ error: err.message });
  }
}
