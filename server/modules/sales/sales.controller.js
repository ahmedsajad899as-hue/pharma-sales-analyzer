/**
 * Sales Controller
 * Handles HTTP request/response for the sales upload endpoint.
 * Delegates all business logic to the service layer.
 */

import { consumePendingOrder } from '../orders/orders.service.js';
import { processUploadedFile, extractInvoiceRows, filterRowsToAssignedItems, insertManualSales,
  checkManualNames, buildWarehouseGapTemplateForUser, parseWarehouseGapFile, getWarehouseGapScope } from './sales.service.js';
import { AppError } from '../../middleware/errorHandler.js';
import prisma from '../../lib/prisma.js';

// موظف المكتب: كل ملف يرفعه يُعمَّم فوراً على حسابات مدير المكتب / HR المكتب /
// مدير الشركة وباقي موظفي المكتب (زملاؤه) — بلا خطوة "مشاركة" يدوية (نفس أثر
// الضغط على "تحديد الكل" في UploadPage، حيث أصبحت القائمة هناك أيضاً بنفس هذه
// الأدوار). يشمل pharmacy_net أيضاً (استثناء من قاعدة "خصوصية pharmacy_net"
// العامة، مقصور على هذا الدور فقط — GET /api/files ومسارات
// pharmacy-analysis.controller.js عُدِّلت لتتحقق من FileUserShare بدل الاكتفاء
// بملكية userId).
// filter_page يبقى مستثنى: أداة تنظيف عمل شخصية بلا قيمة تُشارَك.
export async function autoSyncIfOfficeEmployee(user, fileId, fileType) {
  if (!user || user.role !== 'office_employee' || !fileId) return;
  if (fileType === 'filter_page') return;
  const targets = await prisma.user.findMany({
    where: { isActive: true, id: { not: user.id }, role: { in: ['office_manager', 'office_hr', 'company_manager', 'office_employee'] } },
    select: { id: true },
  });
  if (targets.length === 0) return;
  await prisma.fileUserShare.createMany({
    data: targets.map(u => ({ fileId, userId: u.id })),
    skipDuplicates: true,
  });
}

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

    const fileType = req.body.fileType || 'sales';
    const result = await processUploadedFile(req.file, {
      uploadedBy:     req.body.uploadedBy || req.user?.username || null,
      columnMapping,
      userId:         req.user?.id ?? null,
      fileType,
      sourceCurrency: req.body.sourceCurrency || null,  // user-specified: 'IQD' | 'USD' | null
    });

    // لا تُسقط نجاح الرفع لو فشلت خطوة التعميم التلقائي لسبب عابر
    try {
      await autoSyncIfOfficeEmployee(req.user, result?.uploadedFile?.id, fileType);
    } catch (syncErr) {
      console.error('[autoSyncIfOfficeEmployee]', syncErr);
    }

    return res.status(201).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sales/extract-invoice
 * Accepts one or more invoice IMAGES (multipart, field "images") and returns
 * AI-extracted sale rows for review. Does NOT save anything.
 *
 * Body field "onlyAssignedItems" (optional, string 'true'/'1'): when set, rows
 * whose item doesn't confidently match one of the user's assigned items
 * (UserItemAssignment) are dropped, and kept rows' item names are rewritten to
 * the assigned item's canonical name.
 *
 * Response 200: { success, data: { rows: [...], droppedCount } }
 */
export async function extractInvoice(req, res, next) {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      throw new AppError('لم يتم إرسال أي صورة. أرسل ملفات الصور في الحقل "images".', 400, 'NO_IMAGES');
    }
    const images = files.map(f => ({ mimeType: f.mimetype, base64: f.buffer.toString('base64') }));
    let rows = await extractInvoiceRows(images);
    let droppedCount = 0;
    const onlyAssigned = req.body?.onlyAssignedItems === 'true' || req.body?.onlyAssignedItems === '1';
    if (onlyAssigned) {
      ({ rows, droppedCount } = await filterRowsToAssignedItems(rows, req.user?.id ?? null));
    }
    return res.json({ success: true, data: { rows, droppedCount } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sales/manual
 * Persist manually-entered / invoice-extracted sale rows as Sale records,
 * merged into an existing file or into a new one.
 *
 * Body (application/json):
 *   rows:   [{ repName, item, company?, quantity, totalValue, unitPrice?, pharmacy?, warehouse?, area?, date?, invoiceNumber?, bonus? }]
 *   target: { fileId } | { newFileName, sourceCurrency? }
 *   pendingOrderId?: صفّ PendingBotOrder الذي رُوجعت صفوفه هنا — يُستهلَك (يُحذَف)
 *       بعد نجاح الحفظ. الحذف من السيرفر لا من العميل عمداً: لو مات التبويب بين
 *       الـ201 وطلب الحذف يبقى صفّ يتيم فتُحفَظ الطلبية مرتين.
 *
 * Response 201: { success, data: { addedCount, merged, unknownItems, uploadedFile } }
 */
export async function addManualSales(req, res, next) {
  try {
    const { rows, target, rememberItems, pendingOrderId } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError('لا توجد صفوف للحفظ.', 400, 'NO_ROWS');
    }
    const result = await insertManualSales({
      rows,
      target:     target || {},
      userId:     req.user?.id ?? null,
      uploadedBy: req.user?.username || null,
      rememberItems: Array.isArray(rememberItems) ? rememberItems : [],
    });
    try {
      await autoSyncIfOfficeEmployee(req.user, result?.uploadedFile?.id, 'sales');
    } catch (syncErr) {
      console.error('[autoSyncIfOfficeEmployee]', syncErr);
    }
    // الطلبية "استُهلكت" — نفس نمط commitVisitsImport، best-effort لا يُسقط الحفظ.
    if (pendingOrderId && req.user?.id) await consumePendingOrder(req.user.id, pendingOrderId);
    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sales/check-names
 * يفحص أسماء الايتمات والشركات في الصفوف قبل حفظها ويُرجع ما يحتاج تأكيد
 * المستخدم. قراءة فقط — لا يُنشئ ولا يُعدّل شيئاً.
 *
 * Body: { rows: [{ item, company }] }
 * 200: { success, data: { items, companies, scope } }
 */
export async function checkNames(req, res, next) {
  try {
    const { rows } = req.body || {};
    const data = await checkManualNames({ rows, userId: req.user?.id ?? null });
    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sales/warehouse-gap-scope
 * يُرجع نطاق المستخدم (شركاته/ايتماته/فريقه/مذاخره الاقتراحية) بصيغة JSON —
 * لتغذية اقتراحات ذكية (كتابة حرّة + فلترة فورية) في واجهة الإدخال المباشر
 * داخل التطبيق، بعكس /warehouse-gap-template الذي يبني ملف إكسل للتنزيل.
 */
export async function getWarehouseGapScopeJson(req, res, next) {
  try {
    if (!req.user) throw new AppError('غير مصرّح.', 401, 'UNAUTHORIZED');
    const data = await getWarehouseGapScope(req.user);
    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sales/warehouse-gap-template
 * يُنزّل ملف إكسل خاص بالمستخدم الحالي (شركاته/ايتماته/فريقه) لتوثيق مبيعات
 * مذاخر غابت عن ملف ميركاتو. يُملأ ويُعاد رفعه عبر /api/sales/warehouse-gap-parse.
 */
export async function downloadWarehouseGapTemplate(req, res, next) {
  try {
    if (!req.user) throw new AppError('غير مصرّح.', 401, 'UNAUTHORIZED');
    const { buffer, filename } = await buildWarehouseGapTemplateForUser(req.user);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    return res.send(buffer);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sales/warehouse-gap-parse
 * Multipart: file (نموذج المذاخر المُعبَّأ). معاينة فقط — لا يكتب في قاعدة
 * البيانات؛ الحفظ الفعلي يتم بعدها عبر POST /api/sales/manual (نفس مسار
 * المبيعات اليدوية) بعد مراجعة المستخدم وفحص الأسماء.
 */
export async function parseWarehouseGapUpload(req, res, next) {
  try {
    if (!req.file) throw new AppError('لم يتم إرفاق ملف.', 400, 'NO_FILE');
    const data = await parseWarehouseGapFile(req.file.buffer, req.user?.id ?? null);
    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}