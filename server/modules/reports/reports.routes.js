/**
 * Reports Routes
 * GET /api/reports/representative/:id
 * GET /api/reports/overall
 */

import { Router } from 'express';
import { getRepresentativeReport } from '../representatives/representatives.controller.js';
import { COLUMN_ALIASES } from '../sales/sales.service.js';
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

    // Scope: rely on fileIds (user already sees only their own files from /api/files endpoint)
    // Keeping userId filter only as a fallback when no fileIds provided
    const userOwnershipFilter = (userId && parsedFileIds.length === 0) ? { uploadedFile: { userId } } : {};

    // ── Area filter: when the current user is viewing a file shared WITH them
    //    (not owned by them), restrict results to their assigned areas only ──
    let areaFilter = {};
    if (userId && parsedFileIds.length > 0) {
      // Check if any of the requested files are shared with this user (not owned by them)
      const sharedFiles = await prisma.uploadedFile.findMany({
        where: { id: { in: parsedFileIds }, NOT: { userId }, fileShares: { some: { userId } } },
        select: { id: true },
      });
      if (sharedFiles.length > 0) {
        // Try userAreaAssignment first, then fall back to scientificRepArea
        // (scientific reps have areas in scientificRepArea, not userAreaAssignment)
        let areaIds = [];
        const userAreaRows = await prisma.userAreaAssignment.findMany({
          where: { userId },
          select: { areaId: true },
        });
        if (userAreaRows.length > 0) {
          areaIds = userAreaRows.map(a => a.areaId);
        } else {
          // Check if this user is linked to a scientific rep (via user.linkedRepId)
          const userRow = await prisma.user.findUnique({
            where: { id: userId },
            select: { linkedRepId: true },
          });
          if (userRow?.linkedRepId) {
            const sciAreaRows = await prisma.scientificRepArea.findMany({
              where: { scientificRepId: userRow.linkedRepId },
              select: { areaId: true },
            });
            if (sciAreaRows.length > 0) {
              areaIds = sciAreaRows.map(a => a.areaId);
            }
          }
        }
        if (areaIds.length > 0) {
          areaFilter = { areaId: { in: areaIds } };
        }
      }
    }

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

    // If no date filter provided, auto-detect the real date range from the file
    let effectiveStartDate = startDate ? new Date(startDate) : null;
    // For endDate, extend to end-of-day to include all records on that day regardless of
    // stored time component. e.g. "2026-04-21" → 2026-04-21T23:59:59.999Z so records
    // stored as midnight local time (= 2026-04-20T21:00:00Z in UTC+3) are still included.
    let effectiveEndDate = endDate
      ? (() => { const d = new Date(endDate); d.setUTCHours(23, 59, 59, 999); return d; })()
      : null;

    if (!startDate && !endDate && parsedFileIds.length > 0) {
      // Get the upload dates of ALL selected files (supports multi-file analysis).
      const fileRecords = await prisma.uploadedFile.findMany({
        where: { id: { in: parsedFileIds } },
        select: { uploadedAt: true },
      });

      // Use the LATEST upload moment across the selected files as the cutoff, so real
      // data from every file is kept while garbage records (no Excel date → saleDate
      // defaulted to @default(now()) ≈ that file's uploadedAt) are still excluded.
      const latestUploadedAt = fileRecords.reduce((max, f) => {
        if (!f.uploadedAt) return max;
        const d = new Date(f.uploadedAt);
        return !max || d > max ? d : max;
      }, null);

      if (latestUploadedAt) {
        // Find real date range: only records with saleDate strictly before the upload moment
        const dateRange = await prisma.sale.aggregate({
          where: {
            ...fileFilter,
            ...userOwnershipFilter,
            ...areaFilter,
            ...(recordType ? { recordType } : {}),
            saleDate: { lt: latestUploadedAt },
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
      ...areaFilter,
      ...(effectiveStartDate || effectiveEndDate ? {
        saleDate: {
          ...(effectiveStartDate ? { gte: effectiveStartDate } : {}),
          ...(effectiveEndDate   ? { lte: effectiveEndDate   } : {}),
        },
      } : {}),
      ...(recordType ? { recordType } : {}),
    };

    // Column names that represent "product/item code" in uploaded files —
    // these often contain the company name (e.g. "HUMANISTurkeyN/A")
    const COMPANY_CODE_KEYS = [
      'رقم المادة', 'رقم الماده', 'رقم مادة', 'رقم الماد', 'كود المادة',
      'product code', 'item code', 'material code', 'material no', 'item no',
      'code', 'كود', 'رقم',
    ];

    const extractCompanyFromRaw = (rawData) => {
      if (!rawData) return null;
      try {
        const raw = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        // Priority 1: an actual "company name" column (الشركة/company/المورد/...) —
        // this is the real source of truth when present, even if its value is a
        // messy concatenation like "HUMANISTurkeyN/A".
        for (const key of COLUMN_ALIASES.company) {
          if (raw[key] && String(raw[key]).trim()) return String(raw[key]).trim();
        }
        // Priority 2: known "item/material code" columns, which on some files
        // carry the company name instead (e.g. "رقم المادة" → "HUMANISTurkeyN/A").
        for (const key of COMPANY_CODE_KEYS) {
          if (raw[key] && String(raw[key]).trim()) return String(raw[key]).trim();
        }
        // Priority 3: scan remaining keys for one whose value looks like a company
        // code (Latin letters only, no spaces). Restricted to "code"/"كود" headers —
        // NOT a bare "رقم"/"number" substring, which also matches invoice/order
        // number columns ("رقم الفاتورة") and was wrongly picking up invoice
        // numbers as the "company name".
        for (const [k, v] of Object.entries(raw)) {
          const val = String(v || '').trim();
          if (val && /^[A-Za-z0-9/\-_]+$/.test(val) && val.length > 3 && val.length < 40) {
            const keyLower = k.toLowerCase();
            const looksLikeInvoiceOrOrder = keyLower.includes('فاتورة') || keyLower.includes('فاتوره') || keyLower.includes('invoice') || keyLower.includes('طلب') || keyLower.includes('order');
            if (!looksLikeInvoiceOrOrder && (keyLower.includes('code') || keyLower.includes('كود'))) {
              return val;
            }
          }
        }
      } catch { /* ignore */ }
      return null;
    };

    const sales = await prisma.sale.findMany({
      where,
      select: {
        quantity:   true,
        totalValue: true,
        saleDate:   true,
        rawData:    true,
        area: { select: { id: true, name: true } },
        item: { select: { id: true, name: true, company: { select: { id: true, name: true } }, scientificCompany: { select: { id: true, name: true } } } },
      },
    });

    // Aggregate in-memory by item, by area, by area+item, and by company
    const itemMap     = new Map();
    const areaMap     = new Map();
    const areaItemMap = new Map(); // key: "areaName::itemName"
    const companyMap  = new Map(); // key: companyName
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
        // Priority: DB company relation → scientificCompany relation → rawData column
        const companyName = s.item.company?.name ?? s.item.scientificCompany?.name ?? extractCompanyFromRaw(s.rawData) ?? null;
        if (!itemMap.has(key)) itemMap.set(key, { itemName: s.item.name, companyName, totalQuantity: 0, totalValue: 0 });
        else if (!itemMap.get(key).companyName && companyName) itemMap.get(key).companyName = companyName;
        const r = itemMap.get(key);
        r.totalQuantity += qty;
        r.totalValue    += val;
        // company aggregation
        if (companyName) {
          if (!companyMap.has(companyName)) companyMap.set(companyName, { companyName, totalQuantity: 0, totalValue: 0 });
          const cr = companyMap.get(companyName);
          cr.totalQuantity += qty;
          cr.totalValue    += val;
        }
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

    const byItem     = [...itemMap.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));
    const byArea     = [...areaMap.values()].sort((a, b) => b.totalValue - a.totalValue);
    const byAreaItem = [...areaItemMap.values()];
    const byCompany  = [...companyMap.values()].sort((a, b) => b.totalValue - a.totalValue);

    res.json({ success: true, data: { totalQuantity, totalValue, byItem, byArea, byAreaItem, byCompany, minDate, maxDate, recordCount: sales.length, _debug: { parsedFileIds, userId, effectiveStartDate, effectiveEndDate, whereClause: JSON.stringify(where) } } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
