/**
 * Reports Routes
 * GET /api/reports/representative/:id
 * GET /api/reports/overall
 */

import { Router } from 'express';
import { getRepresentativeReport } from '../representatives/representatives.controller.js';
import prisma from '../../lib/prisma.js';

const router = Router();

router.get('/representative/:id', getRepresentativeReport);

/**
 * GET /api/reports/overall
 * Overall aggregated report across all files (or filtered files).
 * Query params: fileIds, startDate, endDate, recordType
 * Returns: { totalQuantity, totalValue, byItem, byArea }
 */
router.get('/overall', async (req, res) => {
  try {
    const { fileIds, startDate, endDate, recordType } = req.query;
    const userId = req.user?.id ?? null;

    const parsedFileIds = fileIds
      ? String(fileIds).split(',').map(Number).filter(Boolean)
      : [];

    // Always scope to the requesting user's files — prevents reading another user's data
    const userOwnershipFilter = userId ? { uploadedFile: { userId } } : {};

    const fileFilter = parsedFileIds.length === 0
      ? {}
      : parsedFileIds.length === 1
        ? { uploadedFileId: parsedFileIds[0] }
        : { uploadedFileId: { in: parsedFileIds } };

    console.log('[overall] userId:', userId, '| fileIds:', parsedFileIds, '| recordType:', recordType);

    // Quick count without any date filter — to see if records exist at all
    const rawCount = await prisma.sale.count({
      where: { ...fileFilter, ...(recordType ? { recordType } : {}) },
    });
    const ownedCount = await prisma.sale.count({
      where: { ...fileFilter, ...userOwnershipFilter, ...(recordType ? { recordType } : {}) },
    });
    console.log('[overall] rawCount (no userId filter):', rawCount, '| ownedCount (with userId filter):', ownedCount);

    const fileFilter = parsedFileIds.length === 0
      ? {}
      : parsedFileIds.length === 1
        ? { uploadedFileId: parsedFileIds[0] }
        : { uploadedFileId: { in: parsedFileIds } };

    // If no date filter provided, auto-detect the real date range from the file
    let effectiveStartDate = startDate ? new Date(startDate) : null;
    // For endDate, extend to end-of-day to include all records on that day regardless of
    // stored time component. e.g. "2026-04-21" → 2026-04-21T23:59:59.999Z so records
    // stored as midnight local time (= 2026-04-20T21:00:00Z in UTC+3) are still included.
    let effectiveEndDate = endDate
      ? (() => { const d = new Date(endDate); d.setUTCHours(23, 59, 59, 999); return d; })()
      : null;

    if (!startDate && !endDate && parsedFileIds.length > 0) {
      // Get the file's upload date — only if it belongs to the current user
      const fileRecord = await prisma.uploadedFile.findFirst({
        where: { id: parsedFileIds[0], ...(userId ? { userId } : {}) },
        select: { uploadedAt: true },
      });

      if (fileRecord?.uploadedAt) {
        // Use the exact upload timestamp (not midnight of upload day) as the cutoff.
        // Records with no date in Excel get saleDate = @default(now()) ≈ uploadedAt,
        // so using `lt: uploadedAt` correctly excludes only those garbage records
        // while including real data from the same calendar day as the upload.
        const uploadedAt = new Date(fileRecord.uploadedAt);

        // Find real date range: only records with saleDate strictly before the upload moment
        const dateRange = await prisma.sale.aggregate({
          where: {
            ...fileFilter,
            ...userOwnershipFilter,
            ...(recordType ? { recordType } : {}),
            saleDate: { lt: uploadedAt },
          },
          _min: { saleDate: true },
          _max: { saleDate: true },
        });

        if (dateRange._min.saleDate && dateRange._max.saleDate) {
          // Found real dates — scope to that range only
          effectiveStartDate = dateRange._min.saleDate;
          effectiveEndDate   = dateRange._max.saleDate;
        }
        // else: no real Excel dates found at all → leave null → no date filter → return all records
      }
    }

    const where = {
      ...fileFilter,
      ...userOwnershipFilter,
      ...(effectiveStartDate || effectiveEndDate ? {
        saleDate: {
          ...(effectiveStartDate ? { gte: effectiveStartDate } : {}),
          ...(effectiveEndDate   ? { lte: effectiveEndDate   } : {}),
        },
      } : {}),
      ...(recordType ? { recordType } : {}),
    };

    const sales = await prisma.sale.findMany({
      where,
      select: {
        quantity:   true,
        totalValue: true,
        saleDate:   true,
        area: { select: { id: true, name: true } },
        item: { select: { id: true, name: true } },
      },
    });

    // Aggregate in-memory by item, by area, and by area+item
    const itemMap     = new Map();
    const areaMap     = new Map();
    const areaItemMap = new Map(); // key: "areaName::itemName"
    let totalQuantity = 0;
    let totalValue    = 0;
    let minDate = null;
    let maxDate = null;

    for (const s of sales) {
      const qty = s.quantity   || 0;
      const val = s.totalValue || 0;
      totalQuantity += qty;
      totalValue    += val;

      // Track date range
      if (s.saleDate) {
        if (!minDate || s.saleDate < minDate) minDate = s.saleDate;
        if (!maxDate || s.saleDate > maxDate) maxDate = s.saleDate;
      }

      if (s.item) {
        const key = s.item.id;
        if (!itemMap.has(key)) itemMap.set(key, { itemName: s.item.name, totalQuantity: 0, totalValue: 0 });
        const r = itemMap.get(key);
        r.totalQuantity += qty;
        r.totalValue    += val;
      }
      if (s.area) {
        const key = s.area.id;
        if (!areaMap.has(key)) areaMap.set(key, { areaName: s.area.name, totalQuantity: 0, totalValue: 0 });
        const r = areaMap.get(key);
        r.totalQuantity += qty;
        r.totalValue    += val;
      }
      if (s.area && s.item) {
        const key = `${s.area.name}::${s.item.name}`;
        if (!areaItemMap.has(key)) areaItemMap.set(key, { areaName: s.area.name, itemName: s.item.name, totalQuantity: 0, totalValue: 0 });
        const r = areaItemMap.get(key);
        r.totalQuantity += qty;
        r.totalValue    += val;
      }
    }

    const byItem     = [...itemMap.values()].sort((a, b) => b.totalValue - a.totalValue);
    const byArea     = [...areaMap.values()].sort((a, b) => b.totalValue - a.totalValue);
    const byAreaItem = [...areaItemMap.values()];

    res.json({ success: true, data: { totalQuantity, totalValue, byItem, byArea, byAreaItem, minDate, maxDate, recordCount: sales.length, _debug: { parsedFileIds, userId, effectiveStartDate, effectiveEndDate, whereClause: JSON.stringify(where) } } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
