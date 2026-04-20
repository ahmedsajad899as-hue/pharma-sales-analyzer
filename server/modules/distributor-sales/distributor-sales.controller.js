/**
 * Distributor Sales Controller
 * Thin HTTP layer — validates input, delegates to service/repository.
 */

import { parseDistributorExcel } from './distributor-sales.service.js';
import {
  createUpload,
  bulkInsertRecords,
  getUploads,
  getUploadById,
  deleteUploadById,
  getKPIs,
  getByTeam,
  getByDistributor,
  getByItem,
  getReinvoicing,
} from './distributor-sales.repository.js';

// ─── Upload ───────────────────────────────────────────────────
export async function uploadDistributorFile(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const userId = req.user?.id ?? null;
    const { records, warnings } = parseDistributorExcel(req.file.buffer);

    if (records.length === 0) {
      return res.status(422).json({
        error: 'No data rows found in file. Please check the format.',
        warnings,
      });
    }

    const uploadRecord = await createUpload({
      originalName: req.file.originalname,
      filename: req.file.originalname,
      rowCount: records.length,
      userId,
    });

    await bulkInsertRecords(uploadRecord.id, records, userId);

    return res.json({
      success: true,
      uploadId: uploadRecord.id,
      rowCount: records.length,
      warnings,
    });
  } catch (err) {
    console.error('[distributor-sales] upload error:', err);
    return res.status(500).json({ error: err.message || 'Upload failed.' });
  }
}

// ─── List uploads ─────────────────────────────────────────────
export async function listUploads(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const uploads = await getUploads(userId);
    return res.json(uploads);
  } catch (err) {
    console.error('[distributor-sales] listUploads error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Delete upload ────────────────────────────────────────────
export async function deleteUpload(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const { id } = req.params;

    const existing = await getUploadById(id, userId);
    if (!existing) {
      return res.status(404).json({ error: 'Upload not found.' });
    }

    await deleteUploadById(id, userId);
    return res.json({ success: true });
  } catch (err) {
    console.error('[distributor-sales] deleteUpload error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Analysis endpoints ───────────────────────────────────────
export async function getAnalysis(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const { uploadId } = req.query;
    const kpis = await getKPIs(userId, uploadId || null);
    return res.json(kpis);
  } catch (err) {
    console.error('[distributor-sales] getAnalysis error:', err);
    return res.status(500).json({ error: err.message });
  }
}

export async function getTeamAnalysis(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const { uploadId } = req.query;
    const data = await getByTeam(userId, uploadId || null);
    return res.json(data);
  } catch (err) {
    console.error('[distributor-sales] getTeamAnalysis error:', err);
    return res.status(500).json({ error: err.message });
  }
}

export async function getDistributorAnalysis(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const { uploadId } = req.query;
    const data = await getByDistributor(userId, uploadId || null);
    return res.json(data);
  } catch (err) {
    console.error('[distributor-sales] getDistributorAnalysis error:', err);
    return res.status(500).json({ error: err.message });
  }
}

export async function getItemAnalysis(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const { uploadId } = req.query;
    const data = await getByItem(userId, uploadId || null);
    return res.json(data);
  } catch (err) {
    console.error('[distributor-sales] getItemAnalysis error:', err);
    return res.status(500).json({ error: err.message });
  }
}

export async function getReinvoicingList(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const { uploadId } = req.query;
    const data = await getReinvoicing(userId, uploadId || null);
    return res.json(data);
  } catch (err) {
    console.error('[distributor-sales] getReinvoicingList error:', err);
    return res.status(500).json({ error: err.message });
  }
}
