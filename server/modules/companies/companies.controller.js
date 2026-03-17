import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';

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
      items: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
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
  const { name, scientificName, dosage, form, price, scientificMessage } = req.body;
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
      price:             price != null ? parseFloat(price) : null,
      scientificMessage: scientificMessage?.trim() || null,
      scientificCompanyId: companyId,
    },
  });
  res.status(201).json({ success: true, data: item });
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

    // Fetch user assignments
    const assignments = await prisma.userCompanyAssignment.findMany({
      where: { companyId: id },
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
