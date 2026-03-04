/**
 * Sales Controller
 * Handles HTTP request/response for the sales upload endpoint.
 * Delegates all business logic to the service layer.
 */

import { processUploadedFile } from './sales.service.js';
import { AppError } from '../../middleware/errorHandler.js';

/**
 * POST /api/upload-sales
 * Accepts a multipart Excel file and optional metadata.
 *
 * Request (multipart/form-data):
 *   - file:         Excel file (required)
 *   - uploadedBy:   string (optional)
 *   - repNameCol:   Excel column header for rep name (optional)
 *   - areaCol:      Excel column header for area (optional)
 *   - itemCol:      Excel column header for item (optional)
 *   - quantityCol:  Excel column header for quantity (optional)
 *   - totalValueCol: Excel column header for total value (optional)
 *
 * Response 201:
 *   { success, data: { rowCount, skipped, uploadedFile } }
 */
export async function uploadSales(req, res, next) {
  try {
    if (!req.file) {
      throw new AppError('No file uploaded. Send a multipart/form-data request with key "file".', 400, 'NO_FILE');
    }

    // Build optional column mapping from request body
    const columnMapping = {
      repName:    req.body.repNameCol    || undefined,
      area:       req.body.areaCol       || undefined,
      item:       req.body.itemCol       || undefined,
      quantity:   req.body.quantityCol   || undefined,
      totalValue: req.body.totalValueCol || undefined,
    };

    const result = await processUploadedFile(req.file, {
      uploadedBy:    req.body.uploadedBy || req.user?.username || null,
      columnMapping,
      userId:        req.user?.id ?? null,
      fileType:      req.body.fileType || 'sales',
    });

    return res.status(201).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    next(err);
  }
}
