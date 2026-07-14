import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';
import { normalizeItemKey, loadCompanyContext, resolveItemName } from '../../lib/itemResolver.js';
import { mergeItems } from '../sales/sales.repository.js';

// ── List companies (optionally filtered by officeId) ──────────────────────
export async function listCompanies(req, res) {
  const officeId = req.query.officeId ? parseInt(req.query.officeId) : undefined;
  const companies = await prisma.scientificCompany.findMany({
    where: officeId ? { officeId } : undefined,
    include: {
      office: { select: { id: true, name: true } },
      _count: { select: { items: true, lines: true } },
    },
    orderBy: { name: 'asc' },
  });
  res.json({ success: true, data: companies });
}

// ── Get single company with items and lines ───────────────────────────────
export async function getCompany(req, res) {
  const id = parseInt(req.params.id);
  const company = await prisma.scientificCompany.findUnique({
    where: { id },
    include: {
      office: { select: { id: true, name: true } },
      items: { select: { id: true, name: true, scientificName: true, dosage: true, form: true, price: true, warehousePrice: true }, orderBy: { name: 'asc' } },
      lines: {
        include: {
          lineItems: { include: { item: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json({ success: true, data: company });
}

// ── Create company ────────────────────────────────────────────────────────
export async function createCompany(req, res) {
  const { name, officeId, notes } = req.body;
  if (!name || !officeId)
    return res.status(400).json({ error: 'name and officeId required' });

  const company = await prisma.scientificCompany.create({
    data: { name, officeId: parseInt(officeId), notes },
    include: { office: { select: { id: true, name: true } } },
  });
  res.status(201).json({ success: true, data: company });
}

// ── Update company ────────────────────────────────────────────────────────
export async function updateCompany(req, res) {
  const id = parseInt(req.params.id);
  const { name, notes, isActive } = req.body;
  const data = {};
  if (name     !== undefined) data.name     = name;
  if (notes    !== undefined) data.notes    = notes;
  if (isActive !== undefined) data.isActive = Boolean(isActive);

  const company = await prisma.scientificCompany.update({ where: { id }, data });
  res.json({ success: true, data: company });
}

// ── Delete company ────────────────────────────────────────────────────────
export async function deleteCompany(req, res) {
  const id = parseInt(req.params.id);
  await prisma.scientificCompany.delete({ where: { id } });
  res.json({ success: true });
}

// ── Add item to company ───────────────────────────────────────────────────
export async function createCompanyItem(req, res) {
  const companyId = parseInt(req.params.id);
  const { name, scientificName, dosage, form, price, warehousePrice, scientificMessage } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'اسم الايتم مطلوب' });

  // Check if item with same name already exists for this company
  const existing = await prisma.item.findFirst({
    where: { name: name.trim(), scientificCompanyId: companyId },
  });
  if (existing) return res.status(400).json({ error: 'الايتم موجود مسبقاً في هذه الشركة' });

  const item = await prisma.item.create({
    data: {
      name: name.trim(),
      scientificName:    scientificName?.trim()    || null,
      dosage:            dosage?.trim()            || null,
      form:              form?.trim()              || null,
      price:             price          != null && price          !== '' ? parseFloat(price)          : null,
      warehousePrice:    warehousePrice != null && warehousePrice !== '' ? parseFloat(warehousePrice) : null,
      scientificMessage: scientificMessage?.trim() || null,
      scientificCompanyId: companyId,
    },
  });
  res.status(201).json({ success: true, data: item });
}

// ── Update item fields (سعر مكتب / سعر مذخر وغيرها) ────────────────────────
export async function updateCompanyItem(req, res) {
  const companyId = parseInt(req.params.id);
  const itemId    = parseInt(req.params.itemId);
  const { name, scientificName, dosage, form, price, warehousePrice, scientificMessage } = req.body;

  const existing = await prisma.item.findFirst({ where: { id: itemId, scientificCompanyId: companyId } });
  if (!existing) return res.status(404).json({ error: 'الايتم غير موجود في كتالوج هذه الشركة' });

  const data = {};
  if (name               !== undefined) data.name               = name.trim();
  if (scientificName     !== undefined) data.scientificName      = scientificName?.trim()    || null;
  if (dosage              !== undefined) data.dosage              = dosage?.trim()            || null;
  if (form                !== undefined) data.form                = form?.trim()              || null;
  if (scientificMessage   !== undefined) data.scientificMessage   = scientificMessage?.trim() || null;
  if (price               !== undefined) data.price               = price          != null && price          !== '' ? parseFloat(price)          : null;
  if (warehousePrice      !== undefined) data.warehousePrice      = warehousePrice != null && warehousePrice !== '' ? parseFloat(warehousePrice) : null;

  const item = await prisma.item.update({ where: { id: itemId }, data });
  res.json({ success: true, data: item });
}

// ── Remove item from company (unlink) ────────────────────────────────────
export async function deleteCompanyItem(req, res) {
  const itemId = parseInt(req.params.itemId);
  await prisma.item.update({
    where: { id: itemId },
    data: { scientificCompanyId: null },
  });
  res.json({ success: true });
}

// ── Transfer item to another company (نقل ايتم أُدخل بالخطأ) ───────────────
// المبيعات/الرجيع/الزيارات/التارگت تتبع الايتم تلقائياً (نفس الـid). ننظّف فقط
// ما هو مرتبط بالشركة القديمة: قواعد التوحيد (aliases) وارتباط خطوط المنتجات.
// لو وُجد ايتم مطابق بالاسم في الشركة الهدف → دمج بدل التكرار.
export async function transferCompanyItem(req, res) {
  const sourceId = parseInt(req.params.id);
  const itemId   = parseInt(req.params.itemId);
  const targetId = parseInt(req.body?.targetCompanyId);

  if (!targetId) return res.status(400).json({ error: 'الشركة الهدف مطلوبة' });
  if (targetId === sourceId) return res.status(400).json({ error: 'الشركة الهدف مطابقة للشركة الحالية' });

  const item = await prisma.item.findFirst({
    where: { id: itemId, scientificCompanyId: sourceId },
    select: { id: true, name: true },
  });
  if (!item) return res.status(404).json({ error: 'الايتم غير موجود في كتالوج هذه الشركة' });

  const target = await prisma.scientificCompany.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!target) return res.status(404).json({ error: 'الشركة الهدف غير موجودة' });

  // دمج عند التكرار: ايتم كتالوج بنفس المفتاح المُطبَّع في الشركة الهدف
  const key = normalizeItemKey(item.name);
  const targetCatalog = await prisma.item.findMany({
    where: { scientificCompanyId: targetId, isTemp: false },
    select: { id: true, name: true },
  });
  const dup = targetCatalog.find(c => c.id !== itemId && normalizeItemKey(c.name) === key);
  if (dup) {
    await mergeItems(itemId, dup.id); // يعيد ربط كل المراجع للهدف ويحذف المصدر
    return res.json({ success: true, action: 'merged', targetItemId: dup.id });
  }

  // نقل + تنظيف ارتباطات الشركة القديمة
  await prisma.$transaction([
    // ألياسات الشركة القديمة التي تشير لهذا الايتم لم تعد صالحة (نطاقها الشركة)
    prisma.itemMergeRule.deleteMany({ where: { toItemId: itemId, scientificCompanyId: sourceId } }),
    // ارتباط الايتم بخطوط منتجات الشركة القديمة
    prisma.productLineItem.deleteMany({ where: { itemId, line: { is: { companyId: sourceId } } } }),
    // النقل الفعلي
    prisma.item.update({ where: { id: itemId }, data: { scientificCompanyId: targetId } }),
  ]);

  res.json({ success: true, action: 'transferred' });
}

// ════════════════════════════════════════════════════════════════════════════
// ALIASES — قواعد توحيد أسماء الايتمات (نطاق الشركة، مشتركة بين مستخدميها)
// ════════════════════════════════════════════════════════════════════════════

// ── List company aliases ──────────────────────────────────────────────────
export async function listCompanyAliases(req, res) {
  const companyId = parseInt(req.params.id);
  const aliases = await prisma.itemMergeRule.findMany({
    where: { scientificCompanyId: companyId },
    include: { toItem: { select: { id: true, name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({ success: true, data: aliases });
}

// ── Create/update an alias manually (fromName → catalog toItemId) ──────────
export async function createCompanyAlias(req, res) {
  const companyId = parseInt(req.params.id);
  const { fromName, toItemId } = req.body;
  if (!fromName?.trim() || !toItemId) return res.status(400).json({ error: 'الاسم البديل والايتم الهدف مطلوبان' });

  const toItem = await prisma.item.findFirst({
    where: { id: parseInt(toItemId), scientificCompanyId: companyId, isTemp: false },
    select: { id: true, name: true },
  });
  if (!toItem) return res.status(400).json({ error: 'الايتم الهدف غير موجود في كتالوج الشركة' });

  const fromKey = normalizeItemKey(fromName);
  if (!fromKey || normalizeItemKey(toItem.name) === fromKey)
    return res.status(400).json({ error: 'الاسم البديل غير صالح أو مطابق للهدف' });

  const alias = await prisma.itemMergeRule.upsert({
    where:  { scientificCompanyId_fromKey: { scientificCompanyId: companyId, fromKey } },
    update: { fromName: fromName.trim(), toName: toItem.name, toItemId: toItem.id },
    create: { scientificCompanyId: companyId, fromKey, fromName: fromName.trim(), toName: toItem.name, toItemId: toItem.id },
    include: { toItem: { select: { id: true, name: true } } },
  });
  res.status(201).json({ success: true, data: alias });
}

// ── Delete an alias ────────────────────────────────────────────────────────
export async function deleteCompanyAlias(req, res) {
  const companyId = parseInt(req.params.id);
  const aliasId = parseInt(req.params.aliasId);
  await prisma.itemMergeRule.deleteMany({ where: { id: aliasId, scientificCompanyId: companyId } });
  res.json({ success: true });
}

// ════════════════════════════════════════════════════════════════════════════
// REVIEW QUEUE — الايتمات المؤقتة (غير المطابقة) من مستخدمي الشركة
// السوبر أدمن يقرّر: إضافة للكتالوج / ربط بموجود (alias) / حذف.
// ════════════════════════════════════════════════════════════════════════════

// ── List unmatched temp items for a company (with resolver suggestions) ────
export async function getReviewQueue(req, res) {
  const companyId = parseInt(req.params.id);
  const userRows = await prisma.userCompanyAssignment.findMany({ where: { companyId }, select: { userId: true } });
  const userIds = userRows.map(r => r.userId);
  if (userIds.length === 0) return res.json({ success: true, data: [] });

  const temps = await prisma.item.findMany({
    where: { userId: { in: userIds }, isTemp: true },
    select: {
      id: true, name: true, userId: true,
      user: { select: { displayName: true, username: true } },
      _count: { select: { sales: true } },
    },
    orderBy: { name: 'asc' },
  });
  if (temps.length === 0) return res.json({ success: true, data: [] });

  const ctx = await loadCompanyContext([companyId]);
  const data = await Promise.all(temps.map(async t => {
    const r = await resolveItemName(t.name, ctx);
    return {
      id: t.id, name: t.name, userId: t.userId,
      userName: t.user?.displayName || t.user?.username || null,
      salesCount: t._count?.sales ?? 0,
      confidence: r.confidence,
      suggestions: r.suggestions.slice(0, 6),
    };
  }));
  res.json({ success: true, data });
}

// ── Resolve one review item: add | link | delete ──────────────────────────
export async function resolveReviewItem(req, res) {
  const companyId = parseInt(req.params.id);
  const { tempItemId, action, targetItemId } = req.body || {};
  if (!tempItemId || !action) return res.status(400).json({ error: 'tempItemId و action مطلوبان' });

  const temp = await prisma.item.findFirst({
    where: { id: parseInt(tempItemId), isTemp: true },
    select: { id: true, name: true },
  });
  if (!temp) return res.status(404).json({ error: 'الايتم المؤقت غير موجود' });

  const rememberAlias = async (toItem) => {
    const fromKey = normalizeItemKey(temp.name);
    if (!fromKey || normalizeItemKey(toItem.name) === fromKey) return;
    await prisma.itemMergeRule.upsert({
      where:  { scientificCompanyId_fromKey: { scientificCompanyId: companyId, fromKey } },
      update: { fromName: temp.name, toName: toItem.name, toItemId: toItem.id },
      create: { scientificCompanyId: companyId, fromKey, fromName: temp.name, toName: toItem.name, toItemId: toItem.id },
    });
  };

  if (action === 'link') {
    if (!targetItemId) return res.status(400).json({ error: 'targetItemId مطلوب للربط' });
    const target = await prisma.item.findFirst({
      where: { id: parseInt(targetItemId), scientificCompanyId: companyId, isTemp: false },
      select: { id: true, name: true },
    });
    if (!target || target.id === temp.id) return res.status(400).json({ error: 'الهدف غير صالح' });
    await mergeItems(temp.id, target.id);   // نُبقي الكتالوج
    await rememberAlias(target);
    return res.json({ success: true, action: 'link' });
  }

  if (action === 'add') {
    // منع التكرار: إن وُجد ايتم كتالوج بنفس المفتاح → ندمج بدل الإنشاء + alias
    const catalog = await prisma.item.findMany({ where: { scientificCompanyId: companyId, isTemp: false }, select: { id: true, name: true } });
    const key = normalizeItemKey(temp.name);
    const dup = catalog.find(c => normalizeItemKey(c.name) === key);
    if (dup) {
      await mergeItems(temp.id, dup.id);
      await rememberAlias(dup);
      return res.json({ success: true, action: 'merged-duplicate' });
    }
    // ترقية نفس السجل → يحافظ على المبيعات المرتبطة، ويصبح ايتماً قانونياً
    await prisma.item.update({ where: { id: temp.id }, data: { scientificCompanyId: companyId, isTemp: false } });
    return res.json({ success: true, action: 'add' });
  }

  if (action === 'delete') {
    const count = await prisma.sale.count({ where: { itemId: temp.id } });
    if (count > 0) return res.status(409).json({ error: `للايتم ${count} مبيعات — لا يمكن حذفه، اربطه أو أضفه بدلاً من ذلك` });
    await prisma.item.delete({ where: { id: temp.id } });
    return res.json({ success: true, action: 'delete' });
  }

  return res.status(400).json({ error: 'action غير معروف' });
}

// ── Get ALL lines across all companies ──────────────────────────────────
export async function getAllLines(req, res) {
  const lines = await prisma.productLine.findMany({
    include: {
      lineItems: { include: { item: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: lines });
}

// ── List lines of a company ───────────────────────────────────────────────
export async function listLines(req, res) {
  const companyId = parseInt(req.params.id);
  const lines = await prisma.productLine.findMany({
    where: { companyId },
    include: {
      lineItems: { include: { item: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: lines });
}

// ── Create line ───────────────────────────────────────────────────────────
export async function createLine(req, res) {
  const companyId = parseInt(req.params.id);
  const { name, itemIds = [] } = req.body;

  const line = await prisma.productLine.create({
    data: {
      name,
      companyId,
      lineItems: {
        create: itemIds.map(id => ({ item: { connect: { id: parseInt(id) } } })),
      },
    },
    include: {
      lineItems: { include: { item: { select: { id: true, name: true } } } },
    },
  });
  res.status(201).json({ success: true, data: line });
}

// ── Update line ───────────────────────────────────────────────────────────
export async function updateLine(req, res) {
  const lineId = parseInt(req.params.lineId);
  const { name, isActive } = req.body;
  const data = {};
  if (name     !== undefined) data.name     = name;
  if (isActive !== undefined) data.isActive = Boolean(isActive);

  const line = await prisma.productLine.update({ where: { id: lineId }, data });
  res.json({ success: true, data: line });
}

// ── Delete line ───────────────────────────────────────────────────────────
export async function deleteLine(req, res) {
  const lineId = parseInt(req.params.lineId);
  await prisma.productLine.delete({ where: { id: lineId } });
  res.json({ success: true });
}

// ── Set items in a line (replace all) ────────────────────────────────────
export async function setLineItems(req, res) {
  const lineId = parseInt(req.params.lineId);
  const { itemIds = [] } = req.body;

  await prisma.$transaction([
    prisma.productLineItem.deleteMany({ where: { lineId } }),
    prisma.productLineItem.createMany({
      data: itemIds.map(id => ({ lineId, itemId: parseInt(id) })),
      skipDuplicates: true,
    }),
  ]);

  const line = await prisma.productLine.findUnique({
    where: { id: lineId },
    include: {
      lineItems: { include: { item: { select: { id: true, name: true } } } },
    },
  });
  res.json({ success: true, data: line });
}

// ── Get company org chart (users hierarchy + items) ───────────────────────
export async function getCompanyOrg(req, res) {
  try {
    const id = parseInt(req.params.id);

    const company = await prisma.scientificCompany.findUnique({
      where: { id },
      include: {
        office: { select: { id: true, name: true } },
        items: {
          select: { id: true, name: true, scientificName: true, dosage: true, form: true, price: true },
          orderBy: { name: 'asc' },
        },
        lines: {
          include: {
            lineItems: { include: { item: { select: { id: true, name: true } } } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

    // Fetch user assignments — التيم يُبنى على أساس الشركة الرئيسية فقط
    const assignments = await prisma.userCompanyAssignment.findMany({
      where: { companyId: id, isPrimary: true },
      select: { userId: true },
    });

    const userIds = [...new Set(assignments.map(a => a.userId))];

    // Fetch users with their manager relationships
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        isActive: true,
        phone: true,
        managersOfUser:     { select: { managerId: true } },
        subordinatesOfUser: { select: { userId: true } },
      },
    });

    const userIdSet = new Set(userIds);
    const result = users.map(u => ({
      id:             u.id,
      username:       u.username,
      displayName:    u.displayName,
      role:           u.role,
      isActive:       u.isActive,
      phone:          u.phone,
      // Only links between users in this company
      managerIds:     u.managersOfUser.map(m => m.managerId).filter(mid => userIdSet.has(mid)),
      subordinateIds: u.subordinatesOfUser.map(s => s.userId).filter(sid => userIdSet.has(sid)),
    }));

    res.json({ success: true, data: { company, users: result } });
  } catch (err) {
    console.error('[getCompanyOrg]', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── Bulk-import items from pre-parsed JSON (smart frontend detection) ─────
export async function importCompanyItemsJson(req, res) {
  const companyId = parseInt(req.params.id);
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'لا توجد بيانات' });

  const existing = new Set(
    (await prisma.item.findMany({ where: { scientificCompanyId: companyId }, select: { name: true } }))
      .map(i => i.name.toLowerCase().trim())
  );

  const data = items
    .filter(r => r.name?.trim() && !existing.has(r.name.trim().toLowerCase()))
    .map(r => ({
      name:              r.name.trim(),
      scientificName:    r.scientificName    || null,
      dosage:            r.dosage            || null,
      form:              r.form              || null,
      price:             r.price !== '' && r.price != null ? (parseFloat(r.price) || null) : null,
      scientificMessage: r.scientificMessage || null,
      scientificCompanyId: companyId,
    }));

  const result = await prisma.item.createMany({ data, skipDuplicates: true });
  const skipped = items.length - result.count;
  res.json({ success: true, data: { inserted: result.count, skipped } });
}

// ── Bulk-import items for a company from an Excel file ────────────────────
export async function importCompanyItems(req, res) {
  const companyId = parseInt(req.params.id);
  if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });

  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'فشل قراءة الملف: ' + e.message });
  }

  if (!rows.length) return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي بيانات' });

  const normalize = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  const COL_MAP = {
    name:              ['name','اسم_الايتم','الاسم','الايتم','اسم','item','item_name'],
    scientificName:    ['scientificname','scientific_name','الاسم_العلمي','اسم_علمي'],
    dosage:            ['dosage','الجرعة','جرعة','dose'],
    form:              ['form','الشكل','الشكل_الدوائي','dosage_form'],
    price:             ['price','السعر','سعر'],
    scientificMessage: ['scientificmessage','scientific_message','scientific_msg','المسج_العلمي','المسج','ملاحظات','notes'],
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

  let inserted = 0, skipped = 0;
  const errors = [];

  for (const raw of rows) {
    const r = mapRow(raw);
    if (!r.name) { skipped++; continue; }

    const existing = await prisma.item.findFirst({
      where: { name: r.name, scientificCompanyId: companyId },
    });
    if (existing) { skipped++; continue; }

    try {
      await prisma.item.create({
        data: {
          name:              r.name,
          scientificName:    r.scientificName    || null,
          dosage:            r.dosage            || null,
          form:              r.form              || null,
          price:             r.price !== '' ? (parseFloat(r.price) || null) : null,
          scientificMessage: r.scientificMessage || null,
          scientificCompanyId: companyId,
        },
      });
      inserted++;
    } catch (e) {
      errors.push({ name: r.name, error: e.message });
    }
  }

  res.json({ success: true, data: { inserted, skipped, errors } });
}
