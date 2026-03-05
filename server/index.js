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

dotenv.config();

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Auth routes (PUBLIC — no token required) ─────────────────
app.use('/api/auth', authRoutes);

// ── All routes below require a valid JWT ─────────────────────
app.use(requireAuth);

// ── Admin: User management ───────────────────────────────────
app.use('/api/admin/users', usersRoutes);

// ── New Module Routes ────────────────────────────────────────
app.use('/api/representatives',   representativesRoutes);
app.use('/api/scientific-reps',   scientificRepsRoutes);
app.use('/api/reports',           reportsRoutes);
app.use('/api',                   salesRoutes);

// ── Utility routes ───────────────────────────────────────────
app.get('/api/areas', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const areas = await prisma.area.findMany({
      where: userId ? { userId } : {},
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.json({ success: true, data: areas });
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
    const companyId = req.query.companyId ? Number(req.query.companyId) : undefined;
    const items = await prisma.item.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(companyId ? { companyId } : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, companyId: true },
    });
    res.json({ success: true, data: items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/companies', async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const companies = await prisma.company.findMany({
      where: userId ? { userId } : {},
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true,
        items: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
      },
    });
    res.json({ success: true, data: companies });
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
        where: { sales: { none: {} }, scientificReps: { none: {} } },
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
        if (fromId && toId) await mergeItems(fromId, toId);
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
          sales:         { none: {} },  // no sales remain
          scientificReps: { none: {} }, // NOT assigned to any scientific rep
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
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || '');
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
      if (process.env.GOOGLE_API_KEY) {
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

// health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', modules: ['sales', 'representatives', 'reports', 'auth'] });
});

// ── Serve React frontend in production ───────────────────────
if (process.env.NODE_ENV === 'production') {
  const __serverDir = path.dirname(fileURLToPath(import.meta.url));
  const distPath    = path.join(__serverDir, '..', 'dist');
  app.use(express.static(distPath));
  // Catch-all: serve index.html for any non-API route (React Router)
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
      const hash = await bcrypt.hash('admin123', 10);
      const admin = await prisma.user.create({
        data: { username: 'admin', passwordHash: hash, role: 'admin' },
      });
      // Assign all existing data (null userId) to the admin account
      await Promise.all([
        prisma.area.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.item.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.medicalRepresentative.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.scientificRepresentative.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.uploadedFile.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
        prisma.sale.updateMany({ where: { userId: null }, data: { userId: admin.id } }),
      ]);
      console.log('✓ Admin user created → username: admin  |  password: admin123');
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
  app.listen(PORT, async () => {
    console.log(`✓ الخادم يعمل على http://localhost:${PORT}`);
    await seedAdminIfNeeded();
  });
}

export default app;
