import express from 'express';
import multer from 'multer';
import cors from 'cors';
import XLSX from 'xlsx';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import prisma from './lib/prisma.js';

// ── New modules ──────────────────────────────────────────────
import { errorHandler } from './middleware/errorHandler.js';
import { requireAuth } from './middleware/authMiddleware.js';
import { buildNormalizationMap } from './lib/fuzzyMatch.js';
import {
  getAllItems, getAllReps, getAllCompanies,
  mergeItems, mergeReps, mergeCompanies,
} from './modules/sales/sales.repository.js';
import authRoutes              from './modules/auth/auth.routes.js';
import usersRoutes             from './modules/users/users.routes.js';
import salesRoutes              from './modules/sales/sales.routes.js';
import representativesRoutes    from './modules/representatives/representatives.routes.js';
import reportsRoutes            from './modules/reports/reports.routes.js';
import scientificRepsRoutes     from './modules/scientific-reps/scientific-reps.routes.js';
import doctorsRoutes            from './modules/doctors/doctors.routes.js';
import monthlyPlansRoutes       from './modules/monthly-plans/monthly-plans.routes.js';
import superAdminRoutes         from './modules/super-admin/super-admin.routes.js';
import surveyAdminRoutes        from './modules/super-admin/survey-admin.routes.js';
import officesRoutes            from './modules/offices/offices.routes.js';
import companiesRoutes          from './modules/companies/companies.routes.js';
import adminUsersRoutes         from './modules/admin-users/admin-users.routes.js';
import aiAssistantRoutes        from './modules/ai-assistant/ai-assistant.routes.js';
import commercialRoutes          from './modules/commercial/commercial.routes.js';
import trackingRoutes             from './modules/tracking/tracking.routes.js';
import masterSurveyRoutes        from './modules/master-survey/master-survey.routes.js';
import companyMembersRoutes      from './modules/company-members/company-members.routes.js';

dotenv.config();

const app = express();
const upload = multer({ dest: 'uploads/' });

// Multer for item images (keeps file extension, stores in uploads/items/)
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__serverDir, 'uploads', 'items');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `item-${req.params.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('ملفات الصور فقط مسموح بها'), false);
  },
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Serve React frontend in production (BEFORE auth) ─────────
const __serverDir = path.dirname(fileURLToPath(import.meta.url));
const distPath    = path.join(__serverDir, '..', 'dist');

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distPath));
  console.log('✓ Serving static files from:', distPath);
}

// ── Serve uploads (images etc.) — always available ─────────────
app.use('/uploads', express.static(path.join(__serverDir, 'uploads')));

// ── Health check (PUBLIC — no auth required) ─────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ── Auth routes (PUBLIC — no token required) ─────────────────
app.use('/api/auth', authRoutes);

// ── Super Admin routes (own JWT — no requireAuth middleware) ──
app.use('/api/super-admin',         superAdminRoutes);
app.use('/api/super-admin/surveys', surveyAdminRoutes);
app.use('/api/sa/offices',        officesRoutes);
app.use('/api/sa/companies',      companiesRoutes);
app.use('/api/sa/users',          adminUsersRoutes);

// ── SA reference lookups (items + areas for user assignments) ─
import { requireSuperAdmin } from './middleware/superAdminMiddleware.js';
app.get('/api/sa/items', requireSuperAdmin, async (req, res) => {
  const items = await prisma.item.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  res.json({ success: true, data: items });
});
app.get('/api/sa/areas', requireSuperAdmin, async (req, res) => {
  const areas = await prisma.area.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  res.json({ success: true, data: areas });
});

// POST /api/sa/areas/reset-from-survey — clear all areas and reload from master survey
app.post('/api/sa/areas/reset-from-survey', requireSuperAdmin, async (req, res) => {
  try {
    // 1. Get distinct area names from master survey
    const surveyRows = await prisma.masterSurveyDoctor.findMany({
      where: { areaName: { not: null } },
      select: { areaName: true },
      distinct: ['areaName'],
    });
    const surveyNames = [...new Set(surveyRows.map(r => r.areaName.trim()).filter(Boolean))];

    // 2. Get all current areas grouped by name (to detect duplicates)
    const allAreas = await prisma.area.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } });

    // Build map: name → [area ids] sorted by id asc (min id = canonical)
    const byName = new Map();
    for (const a of allAreas) {
      const key = a.name.trim();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(a.id);
    }

    // 3. Merge duplicates using Prisma ORM (avoids raw SQL column name issues)
    for (const [, ids] of byName) {
      if (ids.length <= 1) continue;
      const [canonical, ...dupes] = ids;
      for (const oldId of dupes) {
        // Reroute all FK references to canonical
        await prisma.doctor.updateMany({ where: { areaId: oldId }, data: { areaId: canonical } });
        await prisma.sale.updateMany({ where: { areaId: oldId }, data: { areaId: canonical } });
        await prisma.pharmacyVisit.updateMany({ where: { areaId: oldId }, data: { areaId: canonical } });
        await prisma.pharmacy.updateMany({ where: { areaId: oldId }, data: { areaId: canonical } });
        // PlanArea: composite unique [planId, areaId] — only update if canonical not already there
        const dupePlanAreas = await prisma.planArea.findMany({ where: { areaId: oldId }, select: { planId: true, id: true } });
        for (const pa of dupePlanAreas) {
          const exists = await prisma.planArea.findFirst({ where: { planId: pa.planId, areaId: canonical } });
          if (exists) {
            await prisma.planArea.delete({ where: { id: pa.id } });
          } else {
            await prisma.planArea.update({ where: { id: pa.id }, data: { areaId: canonical } });
          }
        }
        // ScientificRepArea: composite PK [scientificRepId, areaId]
        const dupeRepAreas = await prisma.scientificRepArea.findMany({ where: { areaId: oldId }, select: { scientificRepId: true } });
        for (const ra of dupeRepAreas) {
          const exists = await prisma.scientificRepArea.findFirst({ where: { scientificRepId: ra.scientificRepId, areaId: canonical } });
          if (!exists) await prisma.scientificRepArea.create({ data: { scientificRepId: ra.scientificRepId, areaId: canonical } });
          await prisma.scientificRepArea.delete({ where: { scientificRepId_areaId: { scientificRepId: ra.scientificRepId, areaId: oldId } } });
        }
        // RepresentativeArea: composite PK [representativeId, areaId]
        const dupeRepAreas2 = await prisma.representativeArea.findMany({ where: { areaId: oldId }, select: { representativeId: true } });
        for (const ra of dupeRepAreas2) {
          const exists = await prisma.representativeArea.findFirst({ where: { representativeId: ra.representativeId, areaId: canonical } });
          if (!exists) await prisma.representativeArea.create({ data: { representativeId: ra.representativeId, areaId: canonical } });
          await prisma.representativeArea.delete({ where: { representativeId_areaId: { representativeId: ra.representativeId, areaId: oldId } } });
        }
        // UserAreaAssignment: composite PK [userId, areaId]
        const dupeUserAreas = await prisma.userAreaAssignment.findMany({ where: { areaId: oldId }, select: { userId: true } });
        for (const ua of dupeUserAreas) {
          const exists = await prisma.userAreaAssignment.findFirst({ where: { userId: ua.userId, areaId: canonical } });
          if (!exists) await prisma.userAreaAssignment.create({ data: { userId: ua.userId, areaId: canonical } });
          await prisma.userAreaAssignment.delete({ where: { userId_areaId: { userId: ua.userId, areaId: oldId } } });
        }
        // Delete the duplicate area (cascade handles anything left)
        await prisma.area.delete({ where: { id: oldId } });
      }
    }

    // 4. Add survey names not yet in Area table
    const existingAfter = await prisma.area.findMany({ select: { name: true } });
    const existingNames = new Set(existingAfter.map(a => a.name.trim()));
    const toCreate = surveyNames.filter(n => !existingNames.has(n));
    if (toCreate.length > 0) {
      await prisma.area.createMany({
        data: toCreate.map(name => ({ name })),
        skipDuplicates: true,
      });
    }

    // 5. Delete areas NOT in survey AND having no sales/plan_areas (orphans)
    const surveySet = new Set(surveyNames);
    const allFinal = await prisma.area.findMany({ select: { id: true, name: true } });
    const areasNotInSurvey = allFinal.filter(a => !surveySet.has(a.name.trim()));
    for (const area of areasNotInSurvey) {
      const [saleCount, planCount] = await Promise.all([
        prisma.sale.count({ where: { areaId: area.id } }),
        prisma.planArea.count({ where: { areaId: area.id } }),
      ]);
      if (saleCount === 0 && planCount === 0) {
        // Null out optional FK refs
        await prisma.doctor.updateMany({ where: { areaId: area.id }, data: { areaId: null } });
        await prisma.pharmacyVisit.updateMany({ where: { areaId: area.id }, data: { areaId: null } });
        await prisma.pharmacy.updateMany({ where: { areaId: area.id }, data: { areaId: null } });
        await prisma.scientificRepArea.deleteMany({ where: { areaId: area.id } });
        await prisma.representativeArea.deleteMany({ where: { areaId: area.id } });
        await prisma.userAreaAssignment.deleteMany({ where: { areaId: area.id } });
        await prisma.area.delete({ where: { id: area.id } });
      }
    }

    const finalAreas = await prisma.area.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: finalAreas, count: finalAreas.length });
  } catch (err) {
    console.error('[reset-areas]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── All /api routes below require a valid JWT ────────────────
// Skip auth for health check and auth routes (already handled above)
app.use('/api', (req, res, next) => {
  // Skip JWT for: health-check, auth, and commercial webhook (uses API key auth instead)
  if (req.path === '/health' || req.path.startsWith('/auth') || req.path === '/commercial/invoices/webhook') return next();
  requireAuth(req, res, next);
});

// ── Admin: User management ───────────────────────────────────
app.use('/api/admin/users', usersRoutes);

// ── New Module Routes ────────────────────────────────────────
app.use('/api/representatives',   representativesRoutes);
app.use('/api/scientific-reps',   scientificRepsRoutes);
app.use('/api/reports',           reportsRoutes);
app.use('/api/doctors',           doctorsRoutes);
app.use('/api/monthly-plans',     monthlyPlansRoutes);
app.use('/api/ai-assistant',      aiAssistantRoutes);
app.use('/api/commercial',        commercialRoutes);
app.use('/api/tracking',          trackingRoutes);
app.use('/api/master-surveys',    masterSurveyRoutes);
app.use('/api/company-members',   companyMembersRoutes);
app.use('/api',                   salesRoutes);

// ── OSRM routing proxy (no API key required) ─────────────────
// Route a small chunk (≤10 waypoints) through OSRM demo server
async function osrmRouteChunk(chunk) {
  const coordStr = chunk.map(([lng, lat]) => `${lng},${lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`OSRM ${r.status}`);
  const data = await r.json();
  if (data.code !== 'Ok' || !data.routes?.[0]?.geometry?.coordinates?.length)
    throw new Error('OSRM no route');
  return data.routes[0].geometry.coordinates; // [lng, lat][]
}

app.post('/api/ors/route', async (req, res) => {
  try {
    const { coordinates } = req.body; // array of [lng, lat]
    if (!Array.isArray(coordinates) || coordinates.length < 2)
      return res.status(400).json({ error: 'coordinates array required (min 2)' });

    // Break into small overlapping chunks for reliability
    const CHUNK = 8;
    const chunks = [];
    for (let i = 0; i < coordinates.length; i += CHUNK - 1) {
      const slice = coordinates.slice(i, Math.min(i + CHUNK, coordinates.length));
      if (slice.length >= 2) chunks.push(slice);
    }

    // Route each chunk in parallel (small requests → reliable)
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          return { ok: true, coords: await osrmRouteChunk(chunk) };
        } catch (e) {
          console.warn('[OSRM chunk fallback]', e.message);
          return { ok: false, coords: chunk }; // straight-line fallback for this segment
        }
      })
    );

    // Merge segments (skip first point of each subsequent segment to avoid duplicates)
    const merged = [];
    results.forEach((seg, i) => {
      const start = i === 0 ? 0 : 1;
      for (let j = start; j < seg.coords.length; j++) merged.push(seg.coords[j]);
    });

    const anyRouted = results.some(r => r.ok);
    if (!anyRouted) {
      return res.json({ fallback: true, coordinates });
    }

    res.json({
      features: [{
        geometry: { coordinates: merged }
      }]
    });
  } catch (err) {
    console.error('[OSRM proxy] error:', err);
    res.json({ fallback: true, coordinates: req.body?.coordinates ?? [] });
  }
});

// ── Utility routes ───────────────────────────────────────────
app.get('/api/areas', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    if (!userId) return res.json({ success: true, data: [] });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, linkedRepId: true } });
    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];

    if (user && FIELD_ROLES.includes(user.role)) {
      // Field reps: include owned areas + assigned areas + linked rep areas
      const [assignedRows, repAreaRows] = await Promise.all([
        prisma.userAreaAssignment.findMany({ where: { userId }, select: { areaId: true } }),
        user.linkedRepId
          ? prisma.scientificRepArea.findMany({ where: { scientificRepId: user.linkedRepId }, select: { areaId: true } })
          : Promise.resolve([]),
      ]);
      const extraIds = [...new Set([
        ...assignedRows.map(r => r.areaId),
        ...repAreaRows.map(r => r.areaId),
      ])];
      const areas = await prisma.area.findMany({
        where: { OR: [{ userId }, ...(extraIds.length ? [{ id: { in: extraIds } }] : [])] },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      return res.json({ success: true, data: areas });
    }

    // Manager / admin: areas they own
    const areas = await prisma.area.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.json({ success: true, data: areas });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/areas', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const { name } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    const trimmed = String(name).trim();
    const area = await prisma.area.upsert({
      where:  { name_userId: { name: trimmed, userId } },
      update: {},
      create: { name: trimmed, userId },
      select: { id: true, name: true },
    });
    res.json(area);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Raw sales rows for export (by commercial rep IDs) ────────
// GET /api/export/raw-sales?commRepIds=1,2&fileIds=3,4&startDate=...&endDate=...&recordType=sale|return
app.get('/api/export/raw-sales', async (req, res) => {
  try {
    const { commRepIds, fileId, fileIds, startDate, endDate, recordType } = req.query;
    const userId = req.user?.id ?? null;
    const repIds = commRepIds
      ? String(commRepIds).split(',').map(Number).filter(Boolean)
      : [];
    if (repIds.length === 0) return res.json({ success: true, data: [] });

    // Support both fileIds=1,2,3 (multi) and legacy fileId=1 (single)
    const rawFileIds = fileIds || fileId;
    const parsedFileIds = rawFileIds
      ? String(rawFileIds).split(',').map(Number).filter(Boolean)
      : [];
    const fileIdsFilter = parsedFileIds.length === 0
      ? {}
      : parsedFileIds.length === 1
        ? { uploadedFileId: parsedFileIds[0] }
        : { uploadedFileId: { in: parsedFileIds } };

    const where = {
      representativeId: { in: repIds },
      ...(userId ? { userId } : {}),
      ...fileIdsFilter,
      ...(startDate || endDate ? {
        saleDate: {
          ...(startDate ? { gte: new Date(startDate) } : {}),
          ...(endDate   ? { lte: new Date(endDate)   } : {}),
        },
      } : {}),
      // Filter by recordType if explicitly provided; otherwise export ALL (sales + returns)
      ...(recordType ? { recordType } : {}),
    };

    const sales = await prisma.sale.findMany({
      where,
      include: {
        representative: { select: { name: true } },
        area:           { select: { name: true } },
        item:           { select: { name: true } },
      },
      orderBy: { saleDate: 'asc' },
    });

    res.json({ success: true, data: sales });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/items', async (req, res) => {
  try {
    const userId    = req.user?.id ?? null;
    const userRole  = req.user?.role ?? 'user';
    const companyId = req.query.companyId ? Number(req.query.companyId) : undefined;
    let items;
    const itemSelect = { id: true, name: true, scientificName: true, dosage: true, form: true, price: true, scientificMessage: true, imageUrl: true, companyId: true, company: { select: { id: true, name: true } }, scientificCompanyId: true, scientificCompany: { select: { id: true, name: true } } };
    // scientific_rep/team_leader/supervisor: items via ScientificRepItem junction
    if (['scientific_rep', 'team_leader', 'supervisor'].includes(userRole) && userId) {
      const rep = await prisma.scientificRepresentative.findFirst({
        where: { userId },
        select: { id: true },
      });
      if (rep) {
        const repItems = await prisma.scientificRepItem.findMany({
          where: { scientificRepId: rep.id },
          include: { item: { select: itemSelect } },
        });
        items = repItems.map(ri => ri.item).sort((a, b) => a.name.localeCompare(b.name));
      } else {
        items = [];
      }
    } else {
      // 1. Items owned directly by this user
      const ownedItems = await prisma.item.findMany({
        where: { ...(userId ? { userId } : {}), ...(companyId ? { companyId } : {}) },
        select: itemSelect,
      });
      // 2. Items assigned via UserItemAssignment
      const assignedRows = userId ? await prisma.userItemAssignment.findMany({
        where: { userId },
        select: { item: { select: itemSelect } },
      }) : [];
      const assignedItems = assignedRows.map(r => r.item);
      // 3. Items assigned via RepresentativeItem (linked medical rep)
      let linkedRepItems = [];
      if (userId) {
        const userRecord = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
        if (userRecord?.linkedRepId) {
          const riRows = await prisma.representativeItem.findMany({
            where: { representativeId: userRecord.linkedRepId },
            select: { item: { select: itemSelect } },
          });
          linkedRepItems = riRows.map(r => r.item);
        }
      }
      // 4. Items from user's monthly plan entries (PlanEntryItem)
      let planEntryItems = [];
      if (userId) {
        const plans = await prisma.monthlyPlan.findMany({
          where: { OR: [{ userId }, { assignedUserId: userId }] },
          select: { entries: { select: { targetItems: { select: { item: { select: itemSelect } } } } } },
        });
        planEntryItems = plans.flatMap(p => p.entries.flatMap(e => e.targetItems.map(i => i.item)));
      }
      // 5. Catalog items from the user's scientific companies
      let catalogItems = [];
      if (userId) {
        const userCompanies = await prisma.userCompanyAssignment.findMany({
          where: { userId },
          select: { companyId: true },
        });
        const sciCompanyIds = userCompanies.map(c => c.companyId);
        if (sciCompanyIds.length > 0) {
          catalogItems = await prisma.item.findMany({
            where: { scientificCompanyId: { in: sciCompanyIds }, isTemp: false },
            select: itemSelect,
            orderBy: { name: 'asc' },
          });
        }
      }
      // Deduplicate and sort
      const seen = new Set();
      items = [...catalogItems, ...ownedItems, ...assignedItems, ...linkedRepItems, ...planEntryItems].filter(i => {
        if (seen.has(i.id)) return false;
        seen.add(i.id); return true;
      }).sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json({ success: true, data: items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/items-by-files?fileIds=1,2,3 — items that appear in specific uploaded files
app.get('/api/items-by-files', requireAuth, async (req, res) => {
  try {
    const fileIds = String(req.query.fileIds || '').split(',').map(Number).filter(n => n > 0);
    if (fileIds.length === 0) return res.json({ success: true, data: [] });
    const rows = await prisma.sale.findMany({
      where: { uploadedFileId: { in: fileIds } },
      select: { item: { select: { id: true, name: true } } },
      distinct: ['itemId'],
    });
    const items = rows.map(r => r.item).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, data: items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/items', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const { name, scientificName, dosage, form, price, scientificMessage, companyId } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    const trimmed = String(name).trim();
    const itemSelect = { id: true, name: true, scientificName: true, dosage: true, form: true, price: true, scientificMessage: true, imageUrl: true, companyId: true, company: { select: { id: true, name: true } } };
    const item = await prisma.item.upsert({
      where:  { name_userId: { name: trimmed, userId } },
      update: {
        ...(scientificName    != null ? { scientificName:    scientificName?.trim()    || null } : {}),
        ...(dosage            != null ? { dosage:            dosage?.trim()            || null } : {}),
        ...(form              != null ? { form:              form?.trim()              || null } : {}),
        ...(price             != null ? { price:             price !== '' ? parseFloat(price) : null } : {}),
        ...(scientificMessage != null ? { scientificMessage: scientificMessage?.trim() || null } : {}),
        ...(companyId         != null ? { companyId:         companyId ? parseInt(companyId) : null } : {}),
      },
      create: {
        name: trimmed,
        userId,
        scientificName:    scientificName?.trim()    || null,
        dosage:            dosage?.trim()            || null,
        form:              form?.trim()              || null,
        price:             price != null && price !== '' ? parseFloat(price) : null,
        scientificMessage: scientificMessage?.trim() || null,
        ...(companyId ? { companyId: parseInt(companyId) } : {}),
      },
      select: itemSelect,
    });
    res.status(201).json({ success: true, data: item });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/items/:id', async (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const userId = req.user?.id ?? null;
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صالح' });
    const { name, scientificName, dosage, form, price, scientificMessage } = req.body;
    const updated = await prisma.item.update({
      where: { id },
      data: {
        ...(name              != null ? { name: String(name).trim() }                    : {}),
        ...(scientificName    != null ? { scientificName: scientificName?.trim() || null }   : {}),
        ...(dosage            != null ? { dosage: dosage?.trim() || null }               : {}),
        ...(form              != null ? { form: form?.trim() || null }                   : {}),
        ...(price             != null ? { price: price !== '' ? parseFloat(price) : null } : {}),
        ...(scientificMessage != null ? { scientificMessage: scientificMessage?.trim() || null } : {}),
      },
      select: { id: true, name: true, scientificName: true, dosage: true, form: true, price: true, scientificMessage: true, imageUrl: true, companyId: true, company: { select: { id: true, name: true } } },
    });
    res.json({ success: true, data: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const userId = req.user?.id ?? null;
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صالح' });
    const item = await prisma.item.findFirst({ where: { id, ...(userId ? { userId } : {}) } });
    if (!item) return res.status(404).json({ error: 'الايتم غير موجود' });
    await prisma.item.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/items/:id/image — upload item image
app.post('/api/items/:id/image', requireAuth, imageUpload.single('image'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صالح' });
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف صورة' });
    // Delete old image if exists
    const old = await prisma.item.findUnique({ where: { id }, select: { imageUrl: true } });
    if (old?.imageUrl) {
      const oldPath = path.join(__serverDir, old.imageUrl);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    const imageUrl = `/uploads/items/${req.file.filename}`;
    await prisma.item.update({ where: { id }, data: { imageUrl } });
    res.json({ success: true, imageUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/items/:id/image — remove item image
app.delete('/api/items/:id/image', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صالح' });
    const item = await prisma.item.findUnique({ where: { id }, select: { imageUrl: true } });
    if (item?.imageUrl) {
      const filePath = path.join(__serverDir, item.imageUrl);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await prisma.item.update({ where: { id }, data: { imageUrl: null } });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/items/import-excel — bulk import from xlsx
app.post('/api/items/import-excel', upload.single('file'), async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });

    const buf      = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);
    const wb       = XLSX.read(buf, { type: 'buffer' });
    const sheet    = wb.Sheets[wb.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي بيانات' });

    // Normalize column names (accept Arabic or English headers)
    const normalize = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    const COL_MAP = {
      name:              ['name','اسم_الايتم','الاسم','الايتم','اسم'],
      scientificName:    ['scientificname','scientific_name','الاسم_العلمي','اسم_علمي'],
      dosage:            ['dosage','الجرعة','جرعة'],
      form:              ['form','الشكل','الشكل_الدوائي'],
      price:             ['price','السعر','سعر'],
      scientificMessage: ['scientificmessage','scientific_message','scientific_msg','المسج_العلمي','المسج','ملاحظات','notes'],
      companyName:       ['company','companyname','company_name','الشركة','اسم_الشركة'],
    };

    const mapRow = (raw) => {
      const out = {};
      const keys = Object.keys(raw);
      for (const [field, aliases] of Object.entries(COL_MAP)) {
        const found = keys.find(k => aliases.includes(normalize(k)));
        out[field] = found != null ? String(raw[found]).trim() : '';
      }
      return out;
    };

    let inserted = 0, skipped = 0, errors = [];

    for (const raw of rows) {
      const r = mapRow(raw);
      if (!r.name) { skipped++; continue; }
      try {
        // Optionally resolve company
        let companyId = null;
        if (r.companyName) {
          const co = await prisma.company.findFirst({ where: { name: r.companyName, ...(userId ? { userId } : {}) } });
          if (co) companyId = co.id;
        }
        await prisma.item.upsert({
          where: { name_userId: { name: r.name, userId } },
          create: {
            name: r.name, userId,
            scientificName:    r.scientificName    || null,
            dosage:            r.dosage            || null,
            form:              r.form              || null,
            price:             r.price !== '' ? parseFloat(r.price) || null : null,
            scientificMessage: r.scientificMessage || null,
            ...(companyId ? { companyId } : {}),
          },
          update: {
            scientificName:    r.scientificName    || null,
            dosage:            r.dosage            || null,
            form:              r.form              || null,
            price:             r.price !== '' ? parseFloat(r.price) || null : null,
            scientificMessage: r.scientificMessage || null,
            ...(companyId ? { companyId } : {}),
          },
        });
        inserted++;
      } catch (e) { errors.push(`${r.name}: ${e.message}`); }
    }

    res.json({ success: true, inserted, skipped, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/companies', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    // User-scoped companies
    const companies = await prisma.company.findMany({
      where: userId ? { userId } : {},
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true,
        items: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
      },
    });
    // Scientific companies the user belongs to (via UserCompanyAssignment)
    let sciCompanies = [];
    if (userId) {
      const assignments = await prisma.userCompanyAssignment.findMany({
        where: { userId },
        select: { company: { select: { id: true, name: true } } },
      });
      sciCompanies = assignments.map(a => ({ ...a.company, _isSci: true, items: [] }));
    }
    // Merge, sci companies first; deduplicate by name
    const seen = new Set();
    const merged = [
      ...sciCompanies.map(c => ({ id: c.id, name: c.name, isSci: true, items: [] })),
      ...companies.map(c => ({ id: c.id, name: c.name, isSci: false, items: c.items })),
    ].filter(c => {
      if (seen.has(c.name)) return false;
      seen.add(c.name); return true;
    });
    res.json({ success: true, data: merged });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/companies/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صالح' });
  try {
    const userId = req.user?.id ?? null;
    const co = await prisma.company.findFirst({ where: { id, ...(userId ? { userId } : {}) } });
    if (!co) return res.status(404).json({ error: 'الشركة غير موجودة' });
    // Un-link items first, then delete scientific rep relations, then delete
    await prisma.$transaction([
      prisma.item.updateMany({ where: { companyId: id }, data: { companyId: null } }),
      prisma.scientificRepCompany.deleteMany({ where: { companyId: id } }),
      prisma.company.delete({ where: { id } }),
    ]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Uploaded files list ──────────────────────────────────────
app.get('/api/files', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const files = await prisma.uploadedFile.findMany({
      where: userId ? { userId } : {},
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true, originalName: true, rowCount: true, uploadedAt: true, uploadedBy: true, fileType: true,
        _count: { select: { sales: true } },
      },
    });
    res.json({ success: true, data: files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Cleanup orphan areas & items (not referenced by any sale) ─
app.post('/api/cleanup-orphans', async (req, res) => {
  try {
    // Protect areas/items still assigned to a scientific rep — those are set manually by the user
    const [orphanAreas, orphanItems] = await Promise.all([
      prisma.area.findMany({
        where: { sales: { none: {} }, scientificReps: { none: {} } },
        select: { id: true, name: true },
      }),
      prisma.item.findMany({
        where: { sales: { none: {} }, scientificReps: { none: {} }, planEntryItems: { none: {} } },
        select: { id: true, name: true },
      }),
    ]);
    const areaIds = orphanAreas.map(a => a.id);
    const itemIds = orphanItems.map(i => i.id);
    await Promise.all([
      areaIds.length > 0 ? prisma.area.deleteMany({ where: { id: { in: areaIds } } }) : Promise.resolve(),
      itemIds.length > 0 ? prisma.item.deleteMany({ where: { id: { in: itemIds } } }) : Promise.resolve(),
    ]);
    res.json({
      success: true,
      deletedAreas: areaIds.length,
      deletedItems: itemIds.length,
      areas: orphanAreas.map(a => a.name),
      items: orphanItems.map(i => i.name),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Deduplicate near-duplicate names in DB (dry-run or apply) ────────────────
// POST /api/dedup-names  body: { apply?: boolean }
// dry-run (apply=false) → returns what WOULD be merged; apply=true → actually merges.
app.post('/api/dedup-names', async (req, res) => {
  try {
    const userId  = req.user?.id ?? null;
    const apply   = req.body?.apply === true;

    const [allItemObjs, allRepObjs, allCompanyObjs] = await Promise.all([
      getAllItems(userId),
      getAllReps(userId),
      getAllCompanies(userId),
    ]);

    // Build normalisation maps (incoming = ALL existing names, existing = empty → intra-DB dedup)
    const itemDedup    = buildNormalizationMap(allItemObjs.map(i => i.name),    [], 'item');
    const repDedup     = buildNormalizationMap(allRepObjs.map(r => r.name),     [], 'rep');
    const companyDedup = buildNormalizationMap(allCompanyObjs.map(c => c.name), [], 'company');

    const log = [...itemDedup.log, ...repDedup.log, ...companyDedup.log];

    if (apply && log.length > 0) {
      // Helper: get id for a name in an entity array
      const id = (arr, name) => arr.find(x => x.name === name)?.id;

      for (const entry of itemDedup.log) {
        const fromId = id(allItemObjs, entry.from);
        const toId   = id(allItemObjs, entry.to);
        if (fromId && toId) {
          // Always keep the LONGER (more detailed) name — flip if needed
          const keepId   = entry.from.length >= entry.to.length ? fromId : toId;
          const deleteId = entry.from.length >= entry.to.length ? toId   : fromId;
          await mergeItems(deleteId, keepId);
        }
      }
      for (const entry of repDedup.log) {
        const fromId = id(allRepObjs, entry.from);
        const toId   = id(allRepObjs, entry.to);
        if (fromId && toId) await mergeReps(fromId, toId);
      }
      for (const entry of companyDedup.log) {
        const fromId = id(allCompanyObjs, entry.from);
        const toId   = id(allCompanyObjs, entry.to);
        if (fromId && toId) await mergeCompanies(fromId, toId);
      }
    }

    res.json({ success: true, applied: apply, count: log.length, normalizations: log });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Sync rep-area/item assignments from existing sales data ──
app.post('/api/files/:id/sync-assignments', async (req, res) => {
  const fileId = parseInt(req.params.id);
  if (isNaN(fileId)) return res.status(400).json({ error: 'معرّف غير صالح' });
  try {
    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) return res.status(404).json({ error: 'الملف غير موجود' });

    // Fetch all distinct (repId, areaId, itemId) combos from this file's sales
    const sales = await prisma.sale.findMany({
      where: { uploadedFileId: fileId },
      select: { representativeId: true, areaId: true, itemId: true },
    });

    const repAreaPairs = [...new Map(
      sales.map(s => [`${s.representativeId}-${s.areaId}`, { representativeId: s.representativeId, areaId: s.areaId }])
    ).values()];

    const repItemPairs = [...new Map(
      sales.map(s => [`${s.representativeId}-${s.itemId}`, { representativeId: s.representativeId, itemId: s.itemId }])
    ).values()];

    const [areas, items] = await Promise.all([
      Promise.all(repAreaPairs.map(p => prisma.representativeArea.upsert({
        where:  { representativeId_areaId: p },
        update: {},
        create: p,
      }))),
      Promise.all(repItemPairs.map(p => prisma.representativeItem.upsert({
        where:  { representativeId_itemId: p },
        update: {},
        create: p,
      }))),
    ]);

    res.json({ success: true, assignedAreas: areas.length, assignedItems: items.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete uploaded file ─────────────────────────────────────
app.delete('/api/files/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صالح' });
  try {
    // Check file exists
    const file = await prisma.uploadedFile.findUnique({ where: { id } });
    if (!file) return res.status(404).json({ error: 'الملف غير موجود' });

    // 1. Find all commercial reps that have sales in this file
    const repIdsInFile = await prisma.sale.findMany({
      where: { uploadedFileId: id },
      select: { representativeId: true },
      distinct: ['representativeId'],
    }).then(rows => rows.map(r => r.representativeId));

    // 2. Delete all sales linked to this file
    await prisma.sale.deleteMany({ where: { uploadedFileId: id } });

    // 3. Find which of those reps now have ZERO remaining sales (came only from this file)
    const repsWithSalesElsewhere = await prisma.sale.findMany({
      where: { representativeId: { in: repIdsInFile } },
      select: { representativeId: true },
      distinct: ['representativeId'],
    }).then(rows => new Set(rows.map(r => r.representativeId)));

    const orphanRepIds = repIdsInFile.filter(rid => !repsWithSalesElsewhere.has(rid));

    // 4. Delete orphan reps — skip any that are still linked to a scientific rep as a commercial rep
    if (orphanRepIds.length > 0) {
      const linkedToSciRep = await prisma.scientificRepCommercial.findMany({
        where: { commercialRepId: { in: orphanRepIds } },
        select: { commercialRepId: true },
      }).then(rows => new Set(rows.map(r => r.commercialRepId)));

      const safeToDelete = orphanRepIds.filter(rid => !linkedToSciRep.has(rid));
      if (safeToDelete.length > 0) {
        await prisma.medicalRepresentative.deleteMany({
          where: { id: { in: safeToDelete } },
        });
      }
    }

    // 5. Delete the DB file record
    await prisma.uploadedFile.delete({ where: { id } });

    // 6. Remove physical file from disk if it still exists
    const physicalPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'uploads', file.filename);
    if (fs.existsSync(physicalPath)) fs.unlinkSync(physicalPath);

    // 7. Clean up orphan areas and items (no longer referenced by any sale)
    //    IMPORTANT: Do NOT delete areas/items that are still assigned to a scientific rep —
    //    those assignments are set manually by the user and must be preserved regardless of
    //    whether the underlying file/sales data changes.
    const [orphanAreas, orphanItems] = await Promise.all([
      prisma.area.findMany({
        where: {
          sales:         { none: {} },  // no sales remain
          scientificReps: { none: {} }, // NOT assigned to any scientific rep
        },
        select: { id: true },
      }),
      prisma.item.findMany({
        where: {
          sales:          { none: {} },  // no sales remain
          scientificReps: { none: {} }, // NOT assigned to any scientific rep
          planEntryItems: { none: {} }, // NOT referenced in any monthly plan
        },
        select: { id: true },
      }),
    ]);
    const orphanAreaIds = orphanAreas.map(a => a.id);
    const orphanItemIds = orphanItems.map(i => i.id);
    await Promise.all([
      orphanAreaIds.length > 0 ? prisma.area.deleteMany({ where: { id: { in: orphanAreaIds } } }) : Promise.resolve(),
      orphanItemIds.length > 0 ? prisma.item.deleteMany({ where: { id: { in: orphanItemIds } } }) : Promise.resolve(),
    ]);

    res.json({
      success: true,
      message: `تم حذف الملف وبياناته بنجاح`,
      deletedReps: orphanRepIds.length,
      deletedAreas: orphanAreaIds.length,
      deletedItems: orphanItemIds.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dashboard stats ──────────────────────────────────────────
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const userFilter = userId ? { userId } : {};
    const [sciRepsCount, filesCount, areasCount, totalSales, totalReturns] = await Promise.all([
      prisma.scientificRepresentative.count({ where: { isActive: true, ...userFilter } }),
      prisma.uploadedFile.count({ where: userFilter }),
      prisma.area.count({ where: userFilter }),
      prisma.sale.count({ where: { ...userFilter, recordType: 'sale' } }),
      prisma.sale.count({ where: { ...userFilter, recordType: 'return' } }),
    ]);
    res.json({ success: true, data: { sciRepsCount, filesCount, areasCount, totalSales, totalReturns } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Active-files monetary stats ──────────────────────────────
app.get('/api/dashboard/active-stats', async (req, res) => {
  try {
    const userId     = req.user?.id ?? null;
    const userFilter = userId ? { userId } : {};
    const rawIds     = req.query.fileIds;
    const fileIds    = rawIds ? String(rawIds).split(',').map(Number).filter(n => !isNaN(n)) : [];

    if (fileIds.length === 0) {
      return res.json({ success: true, data: { totalSalesValue: 0, totalReturnsValue: 0, files: [] } });
    }

    const fileFilter = { uploadedFileId: { in: fileIds }, ...userFilter };

    const [salesAgg, returnsAgg, fileList] = await Promise.all([
      prisma.sale.aggregate({ where: { ...fileFilter, recordType: 'sale'   }, _sum: { totalValue: true } }),
      prisma.sale.aggregate({ where: { ...fileFilter, recordType: 'return' }, _sum: { totalValue: true } }),
      prisma.uploadedFile.findMany({ where: { id: { in: fileIds }, ...userFilter }, select: { id: true, originalName: true } }),
    ]);

    const files = await Promise.all(fileList.map(async f => {
      const fw = { uploadedFileId: f.id, ...(userId ? { userId } : {}) };
      const [sa, ra] = await Promise.all([
        prisma.sale.aggregate({ where: { ...fw, recordType: 'sale'   }, _sum: { totalValue: true } }),
        prisma.sale.aggregate({ where: { ...fw, recordType: 'return' }, _sum: { totalValue: true } }),
      ]);
      return { id: f.id, name: f.originalName, salesValue: sa._sum.totalValue ?? 0, returnsValue: ra._sum.totalValue ?? 0 };
    }));

    res.json({
      success: true,
      data: {
        totalSalesValue:   salesAgg._sum.totalValue   ?? 0,
        totalReturnsValue: returnsAgg._sum.totalValue ?? 0,
        files,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Legacy AI Analysis Routes ────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_3 || process.env.GOOGLE_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// رفع الملف وقراءة البيانات
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لا يوجد ملف' });
    }

    // قراءة الملف من النظام
    const fileBuffer = fs.readFileSync(req.file.path);
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    
    // حذف الملف المؤقت بعد المعالجة
    fs.unlinkSync(req.file.path);
    
    res.json({ 
      success: true, 
      data, 
      rowCount: data.length,
      columns: Object.keys(data[0] || {})
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// دالة محلية لتحليل البيانات
function analyzePharmaSalesData(data, filters) {
  if (!data || data.length === 0) {
    return 'لا توجد بيانات للتحليل';
  }

  let filteredData = data;
  
  // تطبيق الفلاتر
  if (filters.salesRep && filters.salesRep.trim()) {
    filteredData = filteredData.filter(row => 
      Object.values(row).some(val => 
        String(val).includes(filters.salesRep)
      )
    );
  }

  if (filters.region && filters.region.trim()) {
    filteredData = filteredData.filter(row => 
      Object.values(row).some(val => 
        String(val).includes(filters.region)
      )
    );
  }

  if (filters.drugName && filters.drugName.trim()) {
    filteredData = filteredData.filter(row => 
      Object.values(row).some(val => 
        String(val).toLowerCase().includes(filters.drugName.toLowerCase())
      )
    );
  }

  if (filteredData.length === 0) {
    return 'لا توجد بيانات تطابق الفلاتر المحددة';
  }

  // إيجاد أعمدة المندوبين والمناطق والمنتجات
  const repColumn = Object.keys(data[0]).find(k => 
    k.toLowerCase().includes('rep') || k.toLowerCase().includes('مندوب')
  );
  const regionColumn = Object.keys(data[0]).find(k => 
    k.toLowerCase().includes('region') || k.toLowerCase().includes('منطقة')
  );
  const drugColumn = Object.keys(data[0]).find(k => 
    k.toLowerCase().includes('drug') || k.toLowerCase().includes('دواء') ||
    k.toLowerCase().includes('product')
  );
  const saleColumn = Object.keys(data[0]).find(k => 
    k.toLowerCase().includes('sale') || k.toLowerCase().includes('مبيعات') ||
    k.toLowerCase().includes('quantity')
  );

  // بناء البيانات حسب المندوب والمنطقة
  const repRegionSales = {};
  filteredData.forEach(row => {
    const rep = repColumn ? row[repColumn] : 'غير محدد';
    const region = regionColumn ? row[regionColumn] : 'غير محدد';
    const drug = drugColumn ? row[drugColumn] : 'منتج';
    const sale = saleColumn ? parseFloat(row[saleColumn]) || 0 : 0;
    
    const key = `${rep}|${region}`;
    if (!repRegionSales[key]) {
      repRegionSales[key] = {
        rep,
        region,
        products: {},
        total: 0
      };
    }
    
    if (!repRegionSales[key].products[drug]) {
      repRegionSales[key].products[drug] = 0;
    }
    
    repRegionSales[key].products[drug] += sale;
    repRegionSales[key].total += sale;
  });

  // حساب الإجمالي الكلي
  const totalSales = Object.values(repRegionSales).reduce((sum, item) => sum + item.total, 0);

  // إنشاء التقرير
  let report = `
📊 تقرير تحليل مبيعات الأدوية
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📈 ملخص البيانات:
• إجمالي السجلات المحللة: ${filteredData.length}
• عدد المندوبين: ${Object.keys(repRegionSales).length}
• إجمالي المبيعات: ${totalSales.toFixed(2)}

`;

  // عرض البيانات حسب المندوب والمنطقة
  report += `👥 المندوبين والمناطق:
`;

  Object.values(repRegionSales).forEach((item, idx) => {
    report += `\n${idx + 1}. المندوب: ${item.rep} | المنطقة: ${item.region}
   `;
    Object.entries(item.products).forEach(([drug, sales]) => {
      report += `\n   • ${drug}: ${Number(sales).toFixed(2)}`;
    });
    report += `\n   📊 الإجمالي للمندوب: ${item.total.toFixed(2)}\n`;
  });

  report += `
✅ تم التحليل بنجاح
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `;

  return report;
}

// تحليل البيانات
app.post('/api/analyze', async (req, res) => {
  try {
    let { data, filters, fileId } = req.body;
    filters = filters || {};

    // إذا لم تُرسل بيانات، نجلبها من قاعدة البيانات
    if (!data || data.length === 0) {
      const dbSales = await prisma.sale.findMany({
        where: {
          ...(fileId ? { uploadedFileId: Number(fileId) } : {}),
          ...(req.user?.id ? { userId: req.user.id } : {}),
        },
        include: {
          representative: { select: { name: true } },
          area:           { select: { name: true } },
          item:           { select: { name: true } },
        },
        take: 2000, // حد أقصى لتجنب البطء
      });

      if (dbSales.length === 0) {
        return res.json({
          success: true,
          analysis: 'لا توجد بيانات مبيعات في قاعدة البيانات. قم برفع ملف Excel أولاً.',
          aiPowered: false,
        });
      }

      // تحويل إلى صيغة مقروءة للـ AI
      data = dbSales.map(s => ({
        'اسم المندوب': s.representative?.name ?? 'غير محدد',
        'المنطقة':     s.area?.name           ?? 'غير محدد',
        'الصنف':       s.item?.name           ?? 'غير محدد',
        'الكمية':      Math.round(s.quantity  || 0),
        'القيمة':      Math.round(s.totalValue || 0),
      }));
    }

    // تقريب القيم الرقمية لتجنب الكسور العشرية الطويلة (floating-point)
    data = data.map(row => {
      const cleaned = {};
      for (const [k, v] of Object.entries(row)) {
        cleaned[k] = (typeof v === 'number' && !Number.isInteger(v)) ? Math.round(v) : v;
      }
      return cleaned;
    });

    // التحليل المحلي الأساسي (كاحتياط)
    const localAnalysis = analyzePharmaSalesData(data, filters);

    // محاولة التحليل بالذكاء الاصطناعي عبر Gemini
    let aiAnalysis = '';
    try {
      if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY_1) {
        const columns = Object.keys(data[0] || {});
        
        const prompt = `أنت محلل بيانات مبيعات أدوية متخصص. قم بتحليل البيانات التالية وقدم تقريراً شاملاً ومفصلاً باللغة العربية.

📋 معلومات البيانات:
- عدد السجلات الكلي: ${data.length}
- الأعمدة: ${columns.join(', ')}
- الفلاتر المطبقة: ${JSON.stringify(filters)}

📊 البيانات الكاملة:
${JSON.stringify(data, null, 2)}

المطلوب تحليله بالتفصيل:

1. 👤 المبيعات حسب المندوب:
   - اعرض جدولاً لكل مندوب يتضمن:
     • اسم كل مادة (صنف/دواء) باعها المندوب
     • الكمية المباعة من كل مادة (عدد الوحدات)
     • القيمة الرقمية للمبيعات (المبلغ) لكل مادة
     • إجمالي كمية المبيعات للمندوب
     • إجمالي قيمة المبيعات للمندوب

2. 💊 المبيعات حسب الصنف (الآيتم/المادة):
   - اعرض جدولاً لكل مادة/صنف/دواء يتضمن:
     • إجمالي الكمية المباعة من هذه المادة
     • إجمالي القيمة الرقمية للمبيعات
     • أي مندوب باع أكثر كمية من هذه المادة
     • أي منطقة فيها أعلى مبيعات لهذه المادة
   - رتّب الأصناف من الأعلى مبيعاً للأقل

3. 📍 المبيعات حسب المنطقة:
   - اعرض جدولاً لكل منطقة يتضمن:
     • اسم كل مادة مباعة في المنطقة مع الكمية والقيمة
     • عدد المندوبين في المنطقة
     • إجمالي كمية مبيعات المنطقة
     • إجمالي قيمة مبيعات المنطقة
   - رتّب المناطق من الأعلى مبيعاً للأقل

4. 📊 ملخص عام:
   - إجمالي الكمية الكلية لجميع المبيعات
   - إجمالي القيمة الكلية لجميع المبيعات
   - أفضل مندوب (كمية وقيمة)
   - أفضل منطقة (كمية وقيمة)
   - أكثر مادة مبيعاً (كمية وقيمة)

ملاحظة مهمة: المبيعات تشمل دائماً بُعدين: الكمية (عدد الوحدات) والقيمة (المبلغ الرقمي). اعرض كليهما في كل جدول.
قدم التقرير بتنسيق واضح ومنظم مع استخدام الأيقونات والجداول.`;

        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        aiAnalysis = response.text();
      }
    } catch (aiError) {
      console.error('AI Analysis error (falling back to local):', aiError.message);
    }

    // إرسال التحليل الذكي أو المحلي
    const finalAnalysis = aiAnalysis 
      ? `🤖 تحليل بالذكاء الاصطناعي (Google Gemini)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${aiAnalysis}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${localAnalysis}`
      : localAnalysis;
    
    res.json({ 
      success: true,
      analysis: finalAnalysis,
      aiPowered: !!aiAnalysis
    });
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Pharmacy Visits API ────────────────────────────────────────
// GET /api/pharmacies/all — return all pharmacy names for this user
app.get('/api/pharmacies/all', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const userFilter = userId ? { userId } : {};
    const visits = await prisma.pharmacyVisit.findMany({
      where: userFilter,
      select: { pharmacyName: true },
      distinct: ['pharmacyName'],
      orderBy: { visitDate: 'desc' },
    });
    const doctors = await prisma.doctor.findMany({
      where: { ...userFilter, pharmacyName: { not: null } },
      select: { pharmacyName: true },
      distinct: ['pharmacyName'],
    });
    const names = new Set();
    visits.forEach(v => { if (v.pharmacyName) names.add(v.pharmacyName); });
    doctors.forEach(d => { if (d.pharmacyName) names.add(d.pharmacyName); });
    res.json([...names].sort((a, b) => a.localeCompare(b)));
  } catch (e) {
    res.json([]);
  }
});

// GET /api/pharmacies/suggestions — autocomplete pharmacy names
app.get('/api/pharmacies/suggestions', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q?.trim()) return res.json([]);
    const userId = req.user?.id ?? null;
    const userFilter = userId ? { userId } : {};
    const qLower = String(q).trim().toLowerCase();
    const visits = await prisma.pharmacyVisit.findMany({
      where: { ...userFilter, pharmacyName: { contains: String(q).trim() } },
      select: { pharmacyName: true },
      distinct: ['pharmacyName'],
      orderBy: { visitDate: 'desc' },
      take: 10,
    });
    // Also check Doctor.pharmacyName field
    const doctors = await prisma.doctor.findMany({
      where: { ...userFilter, pharmacyName: { contains: String(q).trim(), not: null } },
      select: { pharmacyName: true },
      distinct: ['pharmacyName'],
      take: 8,
    });
    const names = new Set();
    visits.forEach(v => { if (v.pharmacyName) names.add(v.pharmacyName); });
    doctors.forEach(d => { if (d.pharmacyName) names.add(d.pharmacyName); });
    // Sort: exact match first, then starts-with, then contains
    const sorted = [...names].sort((a, b) => {
      const al = a.toLowerCase(), bl = b.toLowerCase();
      const as = al.startsWith(qLower), bs = bl.startsWith(qLower);
      if (as && !bs) return -1;
      if (!as && bs) return 1;
      return al.localeCompare(bl);
    });
    res.json(sorted.slice(0, 10));
  } catch (e) {
    res.json([]);
  }
});

// GET /api/pharmacy-area-lookup — auto-fill area for a pharmacy name
app.get('/api/pharmacy-area-lookup', requireAuth, async (req, res) => {
  try {
    const { name } = req.query;
    if (!name?.trim()) return res.json({ areaId: null, areaName: '' });
    const userId = req.user?.id ?? null;
    const userFilter = userId ? { userId } : {};
    const normalize = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const n = normalize(name);
    // 1. Search previous pharmacy visits for matching pharmacy name with an area
    const prevVisits = await prisma.pharmacyVisit.findMany({
      where: { ...userFilter, areaId: { not: null } },
      select: { pharmacyName: true, area: { select: { id: true, name: true } } },
      orderBy: { visitDate: 'desc' },
    });
    const matchedPrev = prevVisits.find(pv => {
      const pvn = normalize(pv.pharmacyName);
      return pvn === n || pvn.includes(n) || n.includes(pvn);
    });
    if (matchedPrev?.area) return res.json({ areaId: matchedPrev.area.id, areaName: matchedPrev.area.name });
    // 2. Search doctors table for same pharmacyName
    const doctors = await prisma.doctor.findMany({
      where: { ...userFilter, pharmacyName: { not: null } },
      select: { pharmacyName: true, area: { select: { id: true, name: true } } },
    });
    const matchedDoc = doctors.find(d => {
      const dn = normalize(d.pharmacyName);
      return dn === n || dn.includes(n) || n.includes(dn);
    });
    if (matchedDoc?.area) return res.json({ areaId: matchedDoc.area.id, areaName: matchedDoc.area.name });
    res.json({ areaId: null, areaName: '' });
  } catch (e) {
    res.json({ areaId: null, areaName: '' });
  }
});

// POST /api/pharmacy-visits  — create a pharmacy visit with items
app.post('/api/pharmacy-visits', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const { pharmacyName, areaId, areaName, items, notes, latitude, longitude, visitDate, isDoubleVisit } = req.body;

    if (!pharmacyName || !pharmacyName.trim()) {
      return res.status(400).json({ error: 'اسم الصيدلية مطلوب' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'يجب إضافة صنف واحد على الأقل' });
    }

    // ── requireGps check ──────────────────────────────────────
    if (userId) {
      const _u = await prisma.user.findUnique({ where: { id: userId }, select: { permissions: true } });
      try { const _p = JSON.parse(_u?.permissions || '{}'); if (_p.requireGps !== false && latitude == null) return res.status(400).json({ error: 'يجب تفعيل الموقع الجغرافي لإرسال هذا التقرير' }); } catch {}
    }

    // Find the linked scientific rep for the current user — managers always get null
    const role = req.user?.role ?? '';
    const MANAGER_ROLES_PH = new Set(['admin', 'manager', 'company_manager', 'supervisor', 'product_manager',
                                       'office_manager', 'commercial_supervisor', 'commercial_team_leader']);
    let scientificRepId = null;
    if (!MANAGER_ROLES_PH.has(role)) {
      scientificRepId = req.user?.linkedRepId ?? null;
      if (!scientificRepId) {
        const rep = await prisma.scientificRepresentative.findFirst({ where: { userId } });
        if (rep) scientificRepId = rep.id;
      }
      if (!scientificRepId) {
        return res.status(400).json({ error: 'لا يوجد مندوب مرتبط بهذا الحساب' });
      }
    }

    // Resolve areaId: from explicit areaId, or look up areaName in areas table
    const normalize = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    let resolvedAreaId = areaId ? parseInt(areaId) : null;
    if (!resolvedAreaId && areaName?.trim()) {
      const allAreas = await prisma.area.findMany({ where: userId ? { userId } : {}, select: { id: true, name: true } });
      const an = normalize(areaName);
      const matchedArea = allAreas.find(a => normalize(a.name) === an || normalize(a.name).includes(an) || an.includes(normalize(a.name)));
      if (matchedArea) resolvedAreaId = matchedArea.id;
    }

    // Resolve items: try itemId first, then fuzzy-match by itemName
    const allItems = await prisma.item.findMany({ where: userId ? { userId } : {}, select: { id: true, name: true } });
    const findItemByName = rawName => {
      const n = normalize(rawName);
      if (!n) return null;
      const exact = allItems.find(i => normalize(i.name) === n);
      if (exact) return exact;
      return allItems.find(i => normalize(i.name).includes(n) || n.includes(normalize(i.name))) || null;
    };
    const itemsToCreate = items
      .map(it => {
        let resolvedItemId = it.itemId ? parseInt(it.itemId) : null;
        let resolvedItemName = null;
        if (!resolvedItemId && it.itemName?.trim()) {
          const matched = findItemByName(it.itemName);
          if (matched) resolvedItemId = matched.id;
          else resolvedItemName = it.itemName.trim();
        }
        return { itemId: resolvedItemId || null, itemName: resolvedItemName, notes: it.notes?.trim() || null };
      })
      .filter(it => it.itemId || it.itemName);

    if (itemsToCreate.length === 0) {
      return res.status(400).json({ error: 'يجب إضافة صنف واحد على الأقل' });
    }

    const finalVisitDate = visitDate ? new Date(visitDate) : new Date();

    const pharmacyVisit = await prisma.pharmacyVisit.create({
      data: {
        pharmacyName: pharmacyName.trim(),
        areaId: resolvedAreaId,
        areaName: resolvedAreaId ? null : (areaName?.trim() || null),
        scientificRepId,
        visitDate: finalVisitDate,
        notes: notes?.trim() || null,
        isDoubleVisit: isDoubleVisit === true || isDoubleVisit === 'true',
        latitude:  latitude  ?? null,
        longitude: longitude ?? null,
        userId,
        items: { create: itemsToCreate },
      },
      include: {
        area:  { select: { id: true, name: true } },
        items: { include: { item: { select: { id: true, name: true } } } },
      },
    });

    res.json({ success: true, data: pharmacyVisit });
  } catch (err) {
    console.error('Pharmacy visit create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/doctor-visits — save a doctor visit without a monthly plan ─────
app.post('/api/doctor-visits', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const role   = req.user?.role ?? '';
    const { doctorId: rawDocId, doctorName, specialty, pharmacyName, areaId, areaName,
            itemId, itemName, feedback, notes, visitDate, latitude, longitude, isDoubleVisit } = req.body;

    // ── requireGps check ──────────────────────────────────────
    if (userId) {
      const _u = await prisma.user.findUnique({ where: { id: userId }, select: { permissions: true } });
      try { const _p = JSON.parse(_u?.permissions || '{}'); if (_p.requireGps !== false && latitude == null) return res.status(400).json({ error: 'يجب تفعيل الموقع الجغرافي لإرسال هذا التقرير' }); } catch {}
    }

    // Resolve scientificRepId — field reps only; managers always get null (tracked by userId)
    const MANAGER_ROLES = new Set(['admin', 'manager', 'company_manager', 'supervisor', 'product_manager',
                                   'office_manager', 'commercial_supervisor', 'commercial_team_leader']);
    let scientificRepId = null;
    if (!MANAGER_ROLES.has(role)) {
      const repRow = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
      scientificRepId = repRow?.id ?? req.user?.linkedRepId ?? null;
      if (!scientificRepId) return res.status(400).json({ error: 'حسابك غير مرتبط بمندوب — تواصل مع المدير' });
    }

    // Resolve areaId from areaName if only text was provided
    let resolvedAreaId = areaId ? parseInt(areaId) : null;
    if (!resolvedAreaId && areaName?.trim()) {
      const nameNorm = areaName.trim().toLowerCase();
      const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
      const found = allAreas.find(a => a.name.trim().toLowerCase() === nameNorm);
      if (found) resolvedAreaId = found.id;
    }

    // Resolve or create doctor
    let doctorId = rawDocId ? parseInt(rawDocId) : null;
    if (!doctorId && doctorName?.trim()) {
      const existing = await prisma.doctor.findFirst({ where: { name: doctorName.trim(), userId } });
      if (existing) { doctorId = existing.id; }
      else {
        const created = await prisma.doctor.create({
          data: { name: doctorName.trim(), specialty: specialty || null, pharmacyName: pharmacyName || null,
                  areaId: resolvedAreaId, userId },
        });
        doctorId = created.id;
      }
    }
    if (!doctorId) return res.status(400).json({ error: 'doctorId أو doctorName مطلوب' });

    // Update existing doctor's null fields if new data was provided (fill missing specialty/pharmacy/area)
    if (rawDocId && (specialty || pharmacyName || resolvedAreaId)) {
      try {
        const docCheck = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { specialty: true, pharmacyName: true, areaId: true } });
        if (docCheck) {
          const docUpd = {};
          if (!docCheck.specialty    && specialty)      docUpd.specialty    = specialty;
          if (!docCheck.pharmacyName && pharmacyName)   docUpd.pharmacyName = pharmacyName;
          if (!docCheck.areaId       && resolvedAreaId) docUpd.areaId       = resolvedAreaId;
          if (Object.keys(docUpd).length > 0) {
            await prisma.doctor.update({ where: { id: doctorId }, data: docUpd });
          }
        }
      } catch (_) { /* non-critical — don't block visit creation */ }
    }

    // Resolve itemId by name if not provided
    let resolvedItemId = itemId ? parseInt(itemId) : null;
    if (!resolvedItemId && itemName?.trim()) {
      const n = String(itemName).trim().toLowerCase();
      let candidates;
      if (['scientific_rep', 'team_leader', 'supervisor'].includes(role)) {
        const ri = await prisma.scientificRepItem.findMany({ where: { scientificRepId }, include: { item: { select: { id: true, name: true } } } });
        candidates = ri.map(r => r.item);
      } else {
        candidates = await prisma.item.findMany({ where: { userId }, select: { id: true, name: true } });
      }
      const match = candidates.find(it => it.name.toLowerCase() === n)
                 || candidates.find(it => it.name.toLowerCase().includes(n) || n.includes(it.name.toLowerCase()));
      if (match) resolvedItemId = match.id;
    }

    const visit = await prisma.doctorVisit.create({
      data: {
        doctorId, scientificRepId, planEntryId: null,
        visitDate:     visitDate ? new Date(visitDate) : new Date(),
        itemId:        resolvedItemId,
        feedback:      feedback ?? 'pending',
        notes:         notes ?? '',
        isDoubleVisit: isDoubleVisit === true || isDoubleVisit === 'true',
        latitude:      latitude  != null ? parseFloat(latitude)  : null,
        longitude:     longitude != null ? parseFloat(longitude) : null,
        userId,
      },
      include: { item: { select: { id: true, name: true } } },
    });
    res.status(201).json(visit);
  } catch (e) {
    console.error('[POST /api/doctor-visits] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/doctor-visits/voice-record — transcribe audio, no plan needed ──
app.post('/api/doctor-visits/voice-record', upload.single('audio'), async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const role   = req.user?.role ?? '';
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف صوتي' });

    // Fetch items accessible to this user
    let allItems;
    if (['scientific_rep', 'team_leader', 'supervisor'].includes(role)) {
      const rep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
      if (rep) {
        const ri = await prisma.scientificRepItem.findMany({ where: { scientificRepId: rep.id }, include: { item: { select: { id: true, name: true } } } });
        allItems = ri.map(r => r.item);
      } else { allItems = []; }
    } else {
      allItems = await prisma.item.findMany({ where: userId ? { userId } : {}, select: { id: true, name: true } });
    }

    const audioData   = fs.readFileSync(req.file.path);
    const audioBase64 = audioData.toString('base64');
    const mimeType    = req.file.mimetype || 'audio/webm';
    fs.unlinkSync(req.file.path);

    const itemNames     = allItems.map(i => `${i.name} (id:${i.id})`).join('\n');
    const feedbackValues = ['writing', 'stocked', 'interested', 'not_interested', 'unavailable', 'pending'];

    const prompt = `أنت متخصص في تحويل التسجيلات الصوتية لمناديب المبيعات الطبية إلى بيانات منظمة.

القاعدة الذهبية: اكتب ما سمعته بالضبط — لا تستبدل أي اسم بأسماء من أي قائمة.

[اسم الطبيب]
• doctorName: اكتب الاسم كما نُطق في التسجيل تماماً — لا تستبدله بأسماء من أي قائمة
• إذا لم يُذكر اسم طبيب → أرجع {"visits":[]}

[الأيتمات]
• itemName: اكتب اسم الدواء كما نُطق في التسجيل
• itemId: أرجعه فقط إذا كنت متأكداً 100% أنه من قائمة الأيتمات أدناه — وإلا null

[الفيدباك]
• feedback: ${feedbackValues.join(' | ')}
• إذا لم يُذكر فيدباك → "pending"
• specialty / pharmacyName / areaName: فقط إذا ذُكرت صراحةً — وإلا ""
• إذا التسجيل فارغ أو غير مفهوم → أرجع {"visits":[]}

قائمة الأيتمات (للمساعدة في itemId فقط):
${itemNames || '(لا توجد أيتمات)'}

أرجع JSON فقط:
{"visits":[{"doctorName":"الاسم كما نُطق","itemId":null,"itemName":"الايتم كما نُطق","feedback":"pending","notes":"","specialty":"","pharmacyName":"","areaName":""}]}`;

    const apiKey = process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_3 || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (!apiKey) return res.status(500).json({ error: 'مفتاح Gemini غير مهيأ' });

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI  = new GoogleGenerativeAI(apiKey);
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent([
      { inlineData: { mimeType, data: audioBase64 } },
      prompt,
    ]);
    const responseText = result.response.text();
    const jsonMatch    = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'تعذر تحليل الصوت', raw: responseText });

    const parsed = JSON.parse(jsonMatch[0]);
    const normalize = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const itemMap   = new Map(allItems.map(it => [normalize(it.name), it]));
    const findItem  = rawName => {
      const n = normalize(rawName);
      if (!n) return null;
      if (itemMap.has(n)) return itemMap.get(n);
      for (const [key, item] of itemMap) {
        if (key.includes(n) || n.includes(key)) return item;
      }
      return null;
    };

    const visits = (parsed.visits || []).map(v => {
      let itemId   = v.itemId || null;
      let itemName = v.itemName || '';
      if (itemName && !itemId) {
        const match = findItem(itemName);
        if (match) { itemId = match.id; itemName = match.name; }
      }
      return {
        entryId:      null,    // no plan — always null
        doctorName:   v.doctorName   || '',
        itemId, itemName,
        feedback:     feedbackValues.includes(v.feedback) ? v.feedback : 'pending',
        notes:        v.notes        || '',
        specialty:    v.specialty    || '',
        pharmacyName: v.pharmacyName || '',
        areaName:     v.areaName     || '',
      };
    });

    res.json({ visits, raw: responseText });
  } catch (e) {
    console.error('[POST /api/doctor-visits/voice-record] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pharmacy-visits/voice-record — transcribe audio and parse pharmacy visit data
app.post('/api/pharmacy-visits/voice-record', upload.single('audio'), async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const role   = req.user?.role ?? '';
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف صوتي' });

    // scientific_rep items come from ScientificRepItem junction, not direct userId ownership
    let allItems;
    if (['scientific_rep', 'team_leader', 'supervisor'].includes(role)) {
      const rep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
      if (rep) {
        const repItems = await prisma.scientificRepItem.findMany({
          where: { scientificRepId: rep.id },
          include: { item: { select: { id: true, name: true } } },
        });
        allItems = repItems.map(ri => ri.item);
      } else {
        allItems = [];
      }
    } else {
      allItems = await prisma.item.findMany({ where: userId ? { userId } : {}, select: { id: true, name: true } });
    }
    const allAreas = await prisma.area.findMany({ where: userId ? { userId } : {}, select: { id: true, name: true } });

    const audioData   = fs.readFileSync(req.file.path);
    const audioBase64 = audioData.toString('base64');
    const mimeType    = req.file.mimetype || 'audio/webm';
    fs.unlinkSync(req.file.path);

    const itemNames = allItems.map(i => `${i.name} (id:${i.id})`).join('\n');
    const areaNames = allAreas.map(a => `${a.name} (id:${a.id})`).join('\n');

    const prompt = `أنت مساعد ذكي لتحليل كلام مندوب طبي. هذا الكول خاص بزيارة صيدلية (وليس طبيب).
استمع للتسجيل الصوتي واستخرج بيانات زيارة الصيدلية.

قواعد:
1. إذا التسجيل فارغ أو غير واضح → أرجع {"pharmacyName":"","areaName":"","items":[]} فوراً
2. استخرج اسم الصيدلية واسم المنطقة إذا ذُكرا
3. استخرج قائمة الأصناف المذكورة — كل صنف قد يكون معه ملاحظات خاصة
4. لا تخترع معلومات لم تُذكر صراحةً

قائمة الأيتمات/الأدوية للمطابقة:
${itemNames}

قائمة المناطق للمطابقة:
${areaNames}

أرجع JSON فقط بدون أي نص آخر:
{"pharmacyName":"اسم الصيدلية","areaName":"اسم المنطقة","items":[{"itemId":123,"itemName":"...","notes":"..."},{"itemId":null,"itemName":"صنف غير موجود","notes":""}]}

ملاحظة: itemId يكون null إذا لم يُطابق أي صنف من القائمة`;

    const apiKey = process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_3 || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (!apiKey) return res.status(500).json({ error: 'مفتاح Gemini غير مهيأ' });

    const genAI  = new GoogleGenerativeAI(apiKey);
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent([
      { inlineData: { mimeType, data: audioBase64 } },
      prompt,
    ]);
    const responseText = result.response.text();
    const jsonMatch    = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'تعذر تحليل الصوت', raw: responseText });

    const parsed = JSON.parse(jsonMatch[0]);

    // Normalize + fuzzy-match items
    const normalize = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const itemMap   = new Map(allItems.map(it => [normalize(it.name), it]));
    const areaMap   = new Map(allAreas.map(a => [normalize(a.name), a]));

    const findItem = rawName => {
      const n = normalize(rawName);
      if (!n) return null;
      if (itemMap.has(n)) return itemMap.get(n);
      for (const [key, item] of itemMap) {
        if (key.includes(n) || n.includes(key)) return item;
      }
      return null;
    };
    const findArea = rawName => {
      const n = normalize(rawName);
      if (!n) return null;
      if (areaMap.has(n)) return areaMap.get(n);
      for (const [key, area] of areaMap) {
        if (key.includes(n) || n.includes(key)) return area;
      }
      return null;
    };

    const matchedArea = findArea(parsed.areaName || '');
    const items = (parsed.items || []).map(it => {
      const matched = it.itemId ? allItems.find(i => i.id === it.itemId) : findItem(it.itemName || '');
      return {
        itemId:   matched ? matched.id : null,
        itemName: matched ? matched.name : (it.itemName || ''),
        notes:    it.notes || '',
      };
    });

    res.json({
      pharmacyName: parsed.pharmacyName || '',
      areaName:     parsed.areaName     || '',
      areaId:       matchedArea ? matchedArea.id : null,
      items,
      raw: responseText,
    });
  } catch (e) {
    console.error('Pharmacy voice parse error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Daily doctor visits for dashboard ────────────────────────
// GET /api/doctor-visits/daily?date=YYYY-MM-DD&repId=5
// Also supports: ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD for multi-day range
app.get('/api/doctor-visits/daily', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const role   = req.user?.role ?? 'user';

    // Support both single date and date range
    const rawFrom = req.query.dateFrom ? String(req.query.dateFrom) : (req.query.date ? String(req.query.date) : null);
    const rawTo   = req.query.dateTo   ? String(req.query.dateTo)   : rawFrom;
    // Parse boundaries as Iraq time (UTC+3) so early-morning visits are not cut off.
    // e.g. "2026-03-11T00:00:00+03:00" = 2026-03-10T21:00:00Z (correct start for March 11 Iraq)
    const todayIQ = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; };
    const safeFrom = rawFrom || todayIQ();
    const safeTo   = rawTo   || safeFrom;
    const dayStart = new Date(safeFrom + 'T00:00:00+03:00');
    const dayEnd   = new Date(safeTo   + 'T23:59:59.999+03:00');

    const repId = req.query.repId ? parseInt(String(req.query.repId)) : null;

    // Build where filter
    const where = {
      visitDate: { gte: dayStart, lte: dayEnd },
    };

    // admin/manager see ALL visits (optionally filtered by repId)
    // user role sees only visits they recorded, scoped to their linked rep
    if (role === 'user') {
      if (userId) where.userId = userId;
      if (req.user?.linkedRepId) where.scientificRepId = req.user.linkedRepId;
    } else if (['scientific_rep', 'team_leader', 'commercial_rep'].includes(role)) {
      // Rep sees ONLY visits attributed to their ScientificRepresentative record.
      // JWT does not carry linkedRepId, so look it up from DB.
      const repUserRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      const repLinkedId = repUserRow?.linkedRepId ?? null;
      let resolvedRepId = repLinkedId;
      if (!resolvedRepId) {
        const ownRep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
        resolvedRepId = ownRep?.id ?? null;
      }
      if (resolvedRepId) {
        where.scientificRepId = resolvedRepId;
      } else {
        // No ScientificRepresentative found — fall back to userId (edge case)
        where.userId = userId;
      }
    } else if (role === 'manager') {
      // manager can filter by rep
      if (repId) where.scientificRepId = repId;
    } else if (['company_manager', 'supervisor', 'product_manager'].includes(role)) {
      if (repId) {
        if (repId < 0) {
          // Negative repId = manager's own visits (encoded as -userId)
          // Filter only by userId — don't require scientificRepId=null because
          // visits created before the fix may have had a repId assigned incorrectly.
          where.userId = -repId;
        } else {
          // Specific scientific rep selected → filter directly
          where.scientificRepId = repId;
        }
      } else {
        // No specific rep → show company reps' visits AND manager's own visits
        const assignments = await prisma.userCompanyAssignment.findMany({
          where: { userId },
          select: { companyId: true },
        });
        const companyIds = assignments.map(a => a.companyId);
        if (companyIds.length > 0) {
          const repUsers = await prisma.user.findMany({
            where: {
              companyAssignments: { some: { companyId: { in: companyIds } } },
              linkedRepId: { not: null },
            },
            select: { linkedRepId: true },
          });
          const repIds = repUsers.map(u => u.linkedRepId).filter(Boolean);
          // Always include manager's own visits (userId = managerId) alongside rep visits
          where.OR = [
            ...(repIds.length > 0 ? [{ scientificRepId: { in: repIds } }] : []),
            { userId },  // manager's own visits (scientificRepId = null)
          ];
        } else {
          // No company assignments: show all visits scoped to manager's userId
          where.userId = userId;
        }
      }
    } else {
      // admin: optionally filter by rep
      if (repId) where.scientificRepId = repId;
    }

    const visits = await prisma.doctorVisit.findMany({
      where,
      include: {
        doctor:        { select: { id: true, name: true, specialty: true, pharmacyName: true, area: { select: { name: true } } } },
        scientificRep: { select: { id: true, name: true } },
        user:          { select: { id: true, displayName: true, username: true } },
        item:          { select: { id: true, name: true } },
        likes:         { select: { id: true, userId: true, user: { select: { id: true, username: true } } } },
        comments:      { select: { id: true, userId: true, content: true, createdAt: true, user: { select: { id: true, username: true } } }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { visitDate: 'asc' },
    });
    // Mark out-of-plan visits (planEntryId is null means doctor was added outside the plan)
    const visitsWithFlag = visits.map(v => ({ ...v, _outOfPlan: v.planEntryId == null, _visitType: 'doctor', _isDoubleVisit: v.isDoubleVisit ?? false }));

    // ── Pharmacy visits for the same date/rep filter ────────
    let pharmVisitsNorm = [];
    try {
    const pharmWhere = {
      visitDate: { gte: dayStart, lte: dayEnd },
    };
    if (role === 'user') {
      if (userId) pharmWhere.userId = userId;
      if (req.user?.linkedRepId) pharmWhere.scientificRepId = req.user.linkedRepId;
    } else if (['scientific_rep', 'team_leader', 'commercial_rep'].includes(role)) {
      // Same resolved repId from above — filter pharmacy visits the same way
      if (resolvedRepId) pharmWhere.scientificRepId = resolvedRepId;
      else if (userId) pharmWhere.userId = userId;
    } else if (role === 'manager') {
      if (repId) pharmWhere.scientificRepId = repId;
    } else if (['company_manager', 'supervisor', 'product_manager'].includes(role)) {
      if (repId) {
        if (repId < 0) {
          // Negative repId = manager's own pharmacy visits (encoded as -userId)
          pharmWhere.userId = -repId;
        } else {
          pharmWhere.scientificRepId = repId;
        }
      } else {
        // Mirror the doctor visits OR clause: rep visits + manager's own
        if (where.OR) pharmWhere.OR = where.OR;
        else if (where.scientificRepId) pharmWhere.scientificRepId = where.scientificRepId;
      }
    } else {
      if (repId) pharmWhere.scientificRepId = repId;
    }
    const pharmacyVisits = await prisma.pharmacyVisit.findMany({
      where: pharmWhere,
      include: {
        area:          { select: { id: true, name: true } },
        scientificRep: { select: { id: true, name: true } },
        user:          { select: { id: true, displayName: true, username: true } },
        items:         { include: { item: { select: { id: true, name: true } } } },
        likes:         { select: { id: true, userId: true, user: { select: { id: true, username: true } } } },
      },
      orderBy: { visitDate: 'asc' },
    });
    // areaName is a plain scalar on PharmacyVisit — included automatically in select
    // Normalize pharmacy visits to match the doctor visit shape for the table
    pharmVisitsNorm = pharmacyVisits.map(pv => ({
      id:           pv.id,
      visitDate:    pv.visitDate,
      latitude:     pv.latitude,
      longitude:    pv.longitude,
      feedback:     'pharmacy',
      notes:        pv.notes,
      scientificRep: pv.scientificRep,
      user:         pv.user ?? null,
      _visitType:   'pharmacy',
      // Mimic the doctor shape so the table renderer can reuse existing columns
      doctor: {
        id:           0,
        name:         pv.pharmacyName,
        specialty:    null,
        pharmacyName: null,
        area:         pv.area ?? (pv.areaName ? { id: 0, name: pv.areaName } : null),
      },
      item:    pv.items[0]?.item ?? null, // primary item for the map
      pharmItems: pv.items,               // all items, for the table
      likes:   pv.likes ?? [],
      _isDoubleVisit: pv.isDoubleVisit ?? false,
    }));
    } catch (pharmErr) {
      console.warn('[daily] PharmacyVisit query skipped:', pharmErr.message);
    }

    // Merge and sort by visitDate
    const allVisits = [...visitsWithFlag, ...pharmVisitsNorm]
      .sort((a, b) => new Date(a.visitDate).getTime() - new Date(b.visitDate).getTime());

    // List of distinct reps who have visits (for filter dropdown)
    // Also includes manager-as-rep entries where scientificRep is null
    const repMap = new Map();
    allVisits.forEach(v => {
      if (v.scientificRep && !repMap.has(v.scientificRep.id)) {
        repMap.set(v.scientificRep.id, v.scientificRep);
      } else if (!v.scientificRep && v.user) {
        // Manager's own visit — use negative userId as numeric id so frontend Number() works
        const key = -(v.user.id);
        if (!repMap.has(key)) {
          repMap.set(key, { id: key, name: v.user.displayName || v.user.username });
        }
      }
    });

    res.json({
      success: true,
      data: {
        visits: allVisits,
        reps: Array.from(repMap.values()),
        total: allVisits.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pharmacy-visits/:id/like  — toggle like (manager/admin only)
app.post('/api/pharmacy-visits/:id/like', async (req, res) => {
  try {
    const userId  = req.user?.id;
    const role    = req.user?.role;
    if (!userId || (role !== 'admin' && role !== 'manager')) return res.status(403).json({ error: 'Forbidden' });
    const visitId = parseInt(req.params.id);
    const existing = await prisma.pharmacyVisitLike.findUnique({ where: { visitId_userId: { visitId, userId } } });
    if (existing) {
      await prisma.pharmacyVisitLike.delete({ where: { visitId_userId: { visitId, userId } } });
    } else {
      await prisma.pharmacyVisitLike.create({ data: { visitId, userId } });
    }
    const likes = await prisma.pharmacyVisitLike.findMany({ where: { visitId }, select: { id: true, userId: true, user: { select: { id: true, username: true } } } });
    res.json({ liked: !existing, likes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Catch-all: serve index.html for React Router (production) ─
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ── Global Error Handler (must be last) ──────────────────────
app.use(errorHandler);

// ─── Seed admin user on first startup ────────────────────────
async function seedAdminIfNeeded() {
  try {
    const count = await prisma.user.count();
    if (count === 0) {
      const hash = await bcrypt.hash('1231234a', 10);
      const admin = await prisma.user.create({
        data: { username: 'admin', passwordHash: hash, role: 'admin' },
      });
      await Promise.all([
        prisma.area.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.item.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.medicalRepresentative.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.scientificRepresentative.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.uploadedFile.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.sale.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
      ]);
      console.log('✓ Admin user created → username: admin  |  password: 1231234a');
    } else {
      // Update existing admin password if needed
      const adminUser = await prisma.user.findUnique({ where: { username: 'admin' } });
      if (adminUser) {
        const hash = await bcrypt.hash('1231234a', 10);
        await prisma.user.update({ where: { id: adminUser.id }, data: { passwordHash: hash } });
        console.log('✓ Admin password updated');
      }
    }
  } catch (e) {
    console.error('Seed error:', e.message);
  }
}

// In Vercel serverless, we export the app instead of calling listen
if (process.env.VERCEL) {
  seedAdminIfNeeded().catch(console.error);
} else {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✓ الخادم يعمل على http://localhost:${PORT}`);
    console.log(`✓ الشبكة المحلية: http://0.0.0.0:${PORT}`);
    await seedAdminIfNeeded();
  });
}

export default app;
