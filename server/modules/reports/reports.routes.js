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

    const fileFilter = parsedFileIds.length === 0
      ? {}
      : parsedFileIds.length === 1
        ? { uploadedFileId: parsedFileIds[0] }
        : { uploadedFileId: { in: parsedFileIds } };

    // If no date filter provided, auto-detect min/max from file data
    let effectiveStartDate = startDate ? new Date(startDate) : null;
    let effectiveEndDate   = endDate   ? new Date(endDate)   : null;

    if (!startDate && !endDate && parsedFileIds.length > 0) {
      const dateRange = await prisma.sale.aggregate({
        where: { ...fileFilter, ...(recordType ? { recordType } : {}) },
        _min: { saleDate: true },
        _max: { saleDate: true },
      });
      if (dateRange._min.saleDate) effectiveStartDate = dateRange._min.saleDate;
      if (dateRange._max.saleDate) effectiveEndDate   = dateRange._max.saleDate;
    }

    const where = {
      ...fileFilter,
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

    res.json({ success: true, data: { totalQuantity, totalValue, byItem, byArea, byAreaItem, minDate, maxDate } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
