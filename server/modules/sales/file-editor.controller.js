/**
 * محرّر الملف المرفوع — تعديل صفوف الإكسل بعد رفعه.
 *
 * التقارير والتصدير تُبنى على صفوف Sale لا على ملف الإكسل (بايتات الملف لا
 * تُحفظ لملفات المبيعات). لذلك «تعديل الإكسل» = تعديل صفوف Sale مباشرةً،
 * وبذلك ينعكس التعديل تلقائياً في كل التقارير والتصدير بلا مزامنة إضافية.
 *
 * الحقول الأساسية (مندوب/منطقة/ايتم/صيدلية) مرتبطة بجداول عبر FK، فتعديلها
 * نصياً يمرّ بنفس دوال التوحيد المستعملة وقت الرفع — وإلا نشأت صفوف مكررة
 * بأسماء مختلفة. ويُحدَّث rawData أيضاً لأن التصدير يقرأ منه.
 */

import prisma from '../../lib/prisma.js';
import {
  findOrCreateArea, findOrCreateItem, findOrCreateCustomer, findRepByName,
} from './sales.repository.js';
import { COLUMN_ALIASES } from './sales.service.js';

const CORE_FIELDS = new Set([
  'repName', 'areaName', 'itemName', 'customerName',
  'quantity', 'totalValue', 'saleDate', 'recordType',
]);

/** أسماء الأعمدة الأساسية كما تظهر للمستخدم. */
export const CORE_LABELS = {
  repName:     'المندوب',
  areaName:    'المنطقة',
  itemName:    'الايتم',
  customerName:'الصيدلية',
  quantity:    'الكمية',
  totalValue:  'القيمة',
  saleDate:    'التاريخ',
  recordType:  'النوع',
};

/** مندوب تجاري بالاسم — ينشئه إن لم يوجد (نفس سلوك الرفع). */
async function resolveRep(name, userId) {
  const trimmed = String(name ?? '').trim() || 'غير محدد';
  const existing = await findRepByName(trimmed, userId);
  if (existing) return existing;
  return prisma.medicalRepresentative.create({ data: { name: trimmed, userId } });
}

/**
 * يربط كل حقل أساسي بمفتاح rawData المقابل في هذا الملف تحديداً.
 * الترويسات تختلف بين الملفات، فنبحث عن أول مفتاح موجود فعلاً يطابق alias.
 */
function buildRawKeyMap(sampleRaw) {
  const keys = Object.keys(sampleRaw || {});
  const lower = keys.map(k => String(k).toLowerCase().trim());
  const pick = (aliases) => {
    for (const a of aliases) {
      const i = lower.indexOf(String(a).toLowerCase());
      if (i !== -1) return keys[i];
    }
    return null;
  };
  return {
    repName:      pick(COLUMN_ALIASES.repName),
    areaName:     pick(COLUMN_ALIASES.area),
    itemName:     pick(COLUMN_ALIASES.item),
    customerName: pick(COLUMN_ALIASES.customer),
    quantity:     pick(COLUMN_ALIASES.quantity),
    totalValue:   pick(COLUMN_ALIASES.totalValue),
    saleDate:     pick(COLUMN_ALIASES.date),
  };
}

/** يتحقق أن المستخدم يملك الملف (التعديل مسموح للمالك فقط). */
async function assertOwner(fileId, userId) {
  const file = await prisma.uploadedFile.findUnique({
    where: { id: fileId }, select: { id: true, userId: true, originalName: true },
  });
  if (!file) return { error: 'الملف غير موجود', status: 404 };
  if (userId && file.userId && file.userId !== userId) {
    return { error: 'لا تملك صلاحية تعديل هذا الملف', status: 403 };
  }
  return { file };
}

/** يأخذ لقطة كاملة لصفوف الملف — مرة واحدة فقط، قبل أول تعديل. */
async function ensureSnapshot(fileId) {
  const existing = await prisma.fileEditSnapshot.findUnique({ where: { fileId }, select: { id: true } });
  if (existing) return { created: false };
  const rows = await prisma.sale.findMany({
    where:  { uploadedFileId: fileId },
    select: {
      representativeId: true, areaId: true, itemId: true, customerId: true,
      quantity: true, totalValue: true, saleDate: true, recordType: true,
      rawData: true, userId: true,
    },
    // الترتيب ضروري: الاسترجاع يعيد الإدراج بترتيب المصفوفة، وبدونه تعود
    // الصفوف بترتيب مختلف عن الملف الأصلي.
    orderBy: { id: 'asc' },
  });
  await prisma.fileEditSnapshot.create({
    data: { fileId, rowCount: rows.length, payload: JSON.stringify(rows) },
  });
  return { created: true, rowCount: rows.length };
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/files/:id/rows — كل صفوف الملف للتعديل
// ════════════════════════════════════════════════════════════════════════════
export async function getFileRows(req, res) {
  try {
    const fileId = parseInt(req.params.id);
    if (!Number.isInteger(fileId)) return res.status(400).json({ error: 'معرّف غير صالح' });
    const guard = await assertOwner(fileId, req.user?.id ?? null);
    if (guard.error) return res.status(guard.status).json({ error: guard.error });

    const sales = await prisma.sale.findMany({
      where: { uploadedFileId: fileId },
      select: {
        id: true, quantity: true, totalValue: true, saleDate: true, recordType: true, rawData: true,
        representative: { select: { name: true } },
        area:           { select: { name: true } },
        item:           { select: { name: true } },
        customer:       { select: { name: true } },
      },
      orderBy: { id: 'asc' },
    });

    // أعمدة rawData الإضافية = كل مفاتيح rawData عبر كل الصفوف، ناقص المفاتيح
    // التي تمثّل حقلاً أساسياً (تُعرض مرة واحدة كعمود أساسي لا مكرَّرة).
    const extraKeys = new Set();
    let sampleRaw = null;
    const parsed = sales.map(s => {
      let raw = {};
      try { if (s.rawData) raw = JSON.parse(s.rawData); } catch { /* صف بلا rawData صالح */ }
      if (!sampleRaw && Object.keys(raw).length) sampleRaw = raw;
      for (const k of Object.keys(raw)) extraKeys.add(k);
      return { s, raw };
    });
    const keyMap = buildRawKeyMap(sampleRaw || {});
    const usedByCore = new Set(Object.values(keyMap).filter(Boolean));
    usedByCore.add('_sheetName');
    const extraColumns = [...extraKeys].filter(k => !usedByCore.has(k));

    const rows = parsed.map(({ s, raw }) => ({
      id: s.id,
      repName:      s.representative?.name ?? '',
      areaName:     s.area?.name ?? '',
      itemName:     s.item?.name ?? '',
      customerName: s.customer?.name ?? '',
      quantity:     s.quantity,
      totalValue:   s.totalValue,
      saleDate:     s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : '',
      recordType:   s.recordType,
      extra: Object.fromEntries(extraColumns.map(k => [k, raw[k] ?? ''])),
    }));

    const snapshot = await prisma.fileEditSnapshot.findUnique({
      where: { fileId }, select: { createdAt: true, rowCount: true },
    });

    res.json({
      success: true,
      data: {
        fileId,
        fileName: guard.file.originalName,
        coreColumns: Object.keys(CORE_LABELS).map(k => ({ key: k, label: CORE_LABELS[k] })),
        extraColumns,
        rows,
        edited: !!snapshot,
        snapshotAt: snapshot?.createdAt ?? null,
        originalRowCount: snapshot?.rowCount ?? rows.length,
      },
    });
  } catch (err) {
    console.error('[file-editor/getFileRows]', err);
    res.status(500).json({ error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PUT /api/files/:id/rows — تطبيق التعديلات
// body: { updates:[{id, field, value}], deletedRowIds:[], deletedColumns:[], newRows:[{...}] }
// ════════════════════════════════════════════════════════════════════════════
export async function saveFileRows(req, res) {
  try {
    const fileId = parseInt(req.params.id);
    if (!Number.isInteger(fileId)) return res.status(400).json({ error: 'معرّف غير صالح' });
    const userId = req.user?.id ?? null;
    const guard = await assertOwner(fileId, userId);
    if (guard.error) return res.status(guard.status).json({ error: guard.error });

    const updates        = Array.isArray(req.body?.updates) ? req.body.updates : [];
    const deletedRowIds  = (req.body?.deletedRowIds ?? []).map(Number).filter(Number.isInteger);
    const deletedColumns = Array.isArray(req.body?.deletedColumns) ? req.body.deletedColumns : [];
    const newRows        = Array.isArray(req.body?.newRows) ? req.body.newRows : [];

    if (!updates.length && !deletedRowIds.length && !deletedColumns.length && !newRows.length) {
      return res.json({ success: true, summary: { updated: 0, deleted: 0, added: 0, columnsRemoved: 0, errors: [] } });
    }

    // لقطة قبل أي تغيير — بلا هذا لا سبيل للرجوع (بايتات الملف الأصلي غير محفوظة)
    const snap = await ensureSnapshot(fileId);
    const summary = { updated: 0, deleted: 0, added: 0, columnsRemoved: 0, errors: [] };

    const sample = await prisma.sale.findFirst({
      where: { uploadedFileId: fileId, rawData: { not: null } }, select: { rawData: true },
    });
    let sampleRaw = {};
    try { if (sample?.rawData) sampleRaw = JSON.parse(sample.rawData); } catch { /* تجاهل */ }
    const keyMap = buildRawKeyMap(sampleRaw);

    // ── 1) تعديل الخلايا ────────────────────────────────────────────────────
    const byRow = new Map();
    for (const u of updates) {
      const id = Number(u?.id);
      if (!Number.isInteger(id)) continue;
      if (!byRow.has(id)) byRow.set(id, []);
      byRow.get(id).push(u);
    }

    for (const [saleId, edits] of byRow) {
      try {
        const sale = await prisma.sale.findFirst({
          where: { id: saleId, uploadedFileId: fileId }, select: { id: true, rawData: true },
        });
        if (!sale) { summary.errors.push(`صف ${saleId} غير موجود في هذا الملف`); continue; }

        const data = {};
        let raw = {};
        try { if (sale.rawData) raw = JSON.parse(sale.rawData); } catch { /* تجاهل */ }
        let rawTouched = false;

        for (const e of edits) {
          const field = String(e?.field ?? '');
          const value = e?.value;

          if (CORE_FIELDS.has(field)) {
            if (field === 'repName') {
              data.representativeId = (await resolveRep(value, userId)).id;
            } else if (field === 'areaName') {
              data.areaId = (await findOrCreateArea(String(value ?? '').trim() || 'غير محدد', userId)).id;
            } else if (field === 'itemName') {
              data.itemId = (await findOrCreateItem(String(value ?? '').trim() || 'غير محدد', userId)).id;
            } else if (field === 'customerName') {
              const name = String(value ?? '').trim();
              data.customerId = name ? (await findOrCreateCustomer(name, userId)).id : null;
            } else if (field === 'quantity') {
              const n = Number(value); data.quantity = Number.isFinite(n) ? Math.trunc(n) : 0;
            } else if (field === 'totalValue') {
              const n = Number(value); data.totalValue = Number.isFinite(n) ? n : 0;
            } else if (field === 'saleDate') {
              const d = value ? new Date(value) : null;
              if (d && !isNaN(d.getTime())) data.saleDate = d;
            } else if (field === 'recordType') {
              data.recordType = value === 'return' ? 'return' : 'sale';
            }
            const rk = keyMap[field];
            if (rk) { raw[rk] = value; rawTouched = true; }
          } else {
            raw[field] = value;
            rawTouched = true;
          }
        }

        if (rawTouched) data.rawData = JSON.stringify(raw);
        if (Object.keys(data).length) {
          await prisma.sale.update({ where: { id: saleId }, data });
          summary.updated++;
        }
      } catch (e) {
        summary.errors.push(`صف ${saleId}: ${e.message}`);
      }
    }

    // ── 2) حذف صفوف ─────────────────────────────────────────────────────────
    if (deletedRowIds.length) {
      const del = await prisma.sale.deleteMany({
        where: { id: { in: deletedRowIds }, uploadedFileId: fileId },
      });
      summary.deleted = del.count;
    }

    // ── 3) حذف أعمدة إضافية (الأساسية محميّة — التقارير تُبنى عليها) ────────
    const coreRawKeys = new Set(Object.values(keyMap).filter(Boolean));
    const removable = deletedColumns.filter(c => !coreRawKeys.has(c) && !CORE_FIELDS.has(c));
    if (removable.length) {
      const rows = await prisma.sale.findMany({
        where: { uploadedFileId: fileId, rawData: { not: null } },
        select: { id: true, rawData: true },
      });
      for (const r of rows) {
        let raw;
        try { raw = JSON.parse(r.rawData); } catch { continue; }
        let changed = false;
        for (const c of removable) if (c in raw) { delete raw[c]; changed = true; }
        if (changed) await prisma.sale.update({ where: { id: r.id }, data: { rawData: JSON.stringify(raw) } });
      }
      summary.columnsRemoved = removable.length;
    }
    if (removable.length !== deletedColumns.length) {
      summary.errors.push('الأعمدة الأساسية محميّة من الحذف — التقارير تُبنى عليها');
    }

    // ── 4) إضافة صفوف ───────────────────────────────────────────────────────
    for (const nr of newRows) {
      try {
        const [rep, area, item] = await Promise.all([
          resolveRep(nr.repName, userId),
          findOrCreateArea(String(nr.areaName ?? '').trim() || 'غير محدد', userId),
          findOrCreateItem(String(nr.itemName ?? '').trim() || 'غير محدد', userId),
        ]);
        const custName = String(nr.customerName ?? '').trim();
        const customer = custName ? await findOrCreateCustomer(custName, userId) : null;
        const qty = Number(nr.quantity);
        const val = Number(nr.totalValue);
        const d = nr.saleDate ? new Date(nr.saleDate) : null;

        const raw = {};
        for (const [k, v] of Object.entries(nr.extra ?? {})) raw[k] = v;
        for (const [field, rk] of Object.entries(keyMap)) if (rk) raw[rk] = nr[field] ?? '';
        raw._addedInEditor = true;

        await prisma.sale.create({
          data: {
            uploadedFileId: fileId,
            userId,
            representativeId: rep.id,
            areaId: area.id,
            itemId: item.id,
            customerId: customer?.id ?? null,
            quantity: Number.isFinite(qty) ? Math.trunc(qty) : 0,
            totalValue: Number.isFinite(val) ? val : 0,
            saleDate: d && !isNaN(d.getTime()) ? d : new Date(),
            recordType: nr.recordType === 'return' ? 'return' : 'sale',
            rawData: JSON.stringify(raw),
          },
        });
        summary.added++;
      } catch (e) {
        summary.errors.push(`صف جديد: ${e.message}`);
      }
    }

    const total = await prisma.sale.count({ where: { uploadedFileId: fileId } });
    await prisma.uploadedFile.update({ where: { id: fileId }, data: { rowCount: total } });

    res.json({ success: true, summary, snapshotCreated: snap.created, rowCount: total });
  } catch (err) {
    console.error('[file-editor/saveFileRows]', err);
    res.status(500).json({ error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/files/:id/restore — إرجاع الملف كما رُفع
// ════════════════════════════════════════════════════════════════════════════
export async function restoreFileRows(req, res) {
  try {
    const fileId = parseInt(req.params.id);
    if (!Number.isInteger(fileId)) return res.status(400).json({ error: 'معرّف غير صالح' });
    const guard = await assertOwner(fileId, req.user?.id ?? null);
    if (guard.error) return res.status(guard.status).json({ error: guard.error });

    const snap = await prisma.fileEditSnapshot.findUnique({ where: { fileId } });
    if (!snap) return res.status(404).json({ error: 'لا توجد نسخة أصلية لهذا الملف — لم يُعدَّل بعد' });

    let rows;
    try { rows = JSON.parse(snap.payload); } catch { return res.status(500).json({ error: 'النسخة الأصلية تالفة' }); }
    if (!Array.isArray(rows)) return res.status(500).json({ error: 'النسخة الأصلية غير صالحة' });

    // استبدال كامل: لا شيء يشير إلى Sale، فحذفها وإعادة إنشائها آمن
    await prisma.$transaction(async (tx) => {
      await tx.sale.deleteMany({ where: { uploadedFileId: fileId } });
      if (rows.length) {
        await tx.sale.createMany({
          data: rows.map(r => ({
            uploadedFileId: fileId,
            userId: r.userId ?? null,
            representativeId: r.representativeId,
            areaId: r.areaId,
            itemId: r.itemId,
            customerId: r.customerId ?? null,
            quantity: r.quantity,
            totalValue: r.totalValue,
            saleDate: r.saleDate ? new Date(r.saleDate) : new Date(),
            recordType: r.recordType || 'sale',
            rawData: r.rawData ?? null,
          })),
        });
      }
      await tx.uploadedFile.update({ where: { id: fileId }, data: { rowCount: rows.length } });
      await tx.fileEditSnapshot.delete({ where: { fileId } });
    }, { timeout: 120000 });

    res.json({ success: true, restored: rows.length });
  } catch (err) {
    console.error('[file-editor/restoreFileRows]', err);
    res.status(500).json({ error: err.message });
  }
}
