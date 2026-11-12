// ════════════════════════════════════════════════════════════════════════════
// items-catalog — صفحة «الايتمات والأسعار» لمدراء الشركات وإدارة المكتب.
//
// التعديل هنا يكتب على نفس صفّ Item (ايتم الكتالوج) الذي يعرضه السوبر أدمن في
// «الايتمات» وتقرأ منه كل الصفحات — فهو ملزم للجميع فوراً، بلا طابور موافقة،
// تماماً كتعديل المدير لاسم مندوبه (company-members.updateMember). كل تعديل
// يُسجَّل في ActivityLog (item_catalog_update / item_catalog_create) فيظهر في
// «تغييرات المناطق» عند السوبر أدمن.
//
// النطاق (من يعدّل ماذا):
//  • الأدوار المكتبية + مدير المنتج: كل شركات مكتبه.
//  • مدير الشركة وغيره: ايتماته المُسنَدة (UserItemAssignment — «الشركة» = ايتمات
//    التيم) إن وُجدت، وإلا كل ايتمات شركاته المُعيَّنة (UserCompanyAssignment).
// الحذف والنقل والدمج تبقى للسوبر أدمن وحده.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { normalizeItemKey } from '../../lib/itemResolver.js';
import { userFeatureOn } from '../../lib/userFeatures.js';
import { isOfficeWideRosterRole } from '../../lib/officeScope.js';

export const FEATURE_KEY = 'items_catalog';
export const EDIT_ROLES = new Set([
  'company_manager', 'office_manager', 'office_hr', 'office_employee', 'product_manager', 'admin', 'manager',
]);

const ITEM_SELECT = {
  id: true, name: true, scientificName: true, dosage: true, form: true,
  price: true, warehousePrice: true, scientificMessage: true, imageUrl: true,
  scientificCompanyId: true,
};
const TEXT_FIELDS  = ['name', 'scientificName', 'dosage', 'form', 'scientificMessage'];
const PRICE_FIELDS = ['price', 'warehousePrice'];
export const FIELD_LABELS = {
  name: 'الاسم', scientificName: 'الاسم العلمي', dosage: 'الجرعة', form: 'الشكل الدوائي',
  price: 'سعر المكتب', warehousePrice: 'سعر المذخر', scientificMessage: 'المسج العلمي',
};

/** يحمّل المستخدم ويتحقّق من الدور والميزة. يرجع null بعد إرسال 403. */
async function loadEditor(req, res) {
  const u = await prisma.user.findUnique({
    where:  { id: req.user.id },
    select: { id: true, role: true, officeId: true, permissions: true, isActive: true },
  });
  if (!u || !u.isActive || !EDIT_ROLES.has(u.role) || !userFeatureOn(u, FEATURE_KEY, { optIn: true })) {
    res.status(403).json({ error: 'صفحة الايتمات غير مفعّلة لحسابك.' });
    return null;
  }
  return u;
}

/**
 * نطاق المستخدم: الشركات التي يرى ايتماتها/يضيف إليها، والايتمات التي يعدّلها.
 * itemIds = null ⇒ كل ايتمات الكتالوج في companyIds.
 */
async function resolveScope(u) {
  const assigned = await prisma.userCompanyAssignment.findMany({
    where: { userId: u.id }, select: { companyId: true },
  });
  const companyIds = new Set(assigned.map(a => a.companyId));

  if (isOfficeWideRosterRole(u.role)) {
    if (u.officeId) {
      const all = await prisma.scientificCompany.findMany({ where: { officeId: u.officeId }, select: { id: true } });
      for (const c of all) companyIds.add(c.id);
    }
    return { companyIds: [...companyIds], itemIds: null };
  }

  // «الشركة» = ايتمات التيم المُسنَدة للمدير (قد تأتي من شركات علمية أخرى)
  const wl = await prisma.userItemAssignment.findMany({
    where:  { userId: u.id, item: { is: { isTemp: false, scientificCompanyId: { not: null } } } },
    select: { itemId: true },
  });
  if (wl.length) return { companyIds: [...companyIds], itemIds: wl.map(w => w.itemId) };
  return { companyIds: [...companyIds], itemIds: null };
}

function itemWhere(scope) {
  return scope.itemIds
    ? { id: { in: scope.itemIds }, isTemp: false, scientificCompanyId: { not: null } }
    : { scientificCompanyId: { in: scope.companyIds }, isTemp: false };
}

function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[,،\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

async function logChange(userId, action, details) {
  try {
    await prisma.activityLog.create({
      data: { userId, action, module: 'items-catalog', details: JSON.stringify(details) },
    });
  } catch (e) { console.warn('[items-catalog] activity log failed (non-fatal):', e.message); }
}

/** آخر تعديل لكل ايتم (من ActivityLog) — يُعرض «عُدّل بواسطة … قبل …». */
async function lastEdits(itemIds) {
  if (!itemIds.length) return new Map();
  const rows = await prisma.activityLog.findMany({
    where:   { action: { in: ['item_catalog_update', 'item_catalog_create'] } },
    orderBy: { createdAt: 'desc' },
    take:    2000,
    select:  { createdAt: true, details: true, user: { select: { displayName: true, username: true } } },
  });
  const want = new Set(itemIds);
  const out = new Map();
  for (const r of rows) {
    let d = {};
    try { d = JSON.parse(r.details || '{}'); } catch {}
    const id = Number(d.itemId);
    if (!want.has(id) || out.has(id)) continue;
    out.set(id, { at: r.createdAt, by: r.user ? (r.user.displayName || r.user.username) : '—' });
  }
  return out;
}

// GET /api/items-catalog
export async function listCatalog(req, res, next) {
  try {
    const u = await loadEditor(req, res); if (!u) return;
    const scope = await resolveScope(u);
    const items = await prisma.item.findMany({ where: itemWhere(scope), select: ITEM_SELECT, orderBy: { name: 'asc' } });

    const companyIdsShown = new Set([...scope.companyIds, ...items.map(i => i.scientificCompanyId)]);
    const companies = await prisma.scientificCompany.findMany({
      where:   { id: { in: [...companyIdsShown] } },
      select:  { id: true, name: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    const edits = await lastEdits(items.map(i => i.id));

    res.json({
      success: true,
      data: {
        companies,
        addableCompanyIds: scope.companyIds,
        items: items.map(i => ({ ...i, lastEdit: edits.get(i.id) ?? null })),
      },
    });
  } catch (err) { next(err); }
}

// PATCH /api/items-catalog/items/:itemId
export async function updateItem(req, res, next) {
  try {
    const u = await loadEditor(req, res); if (!u) return;
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'معرّف غير صالح' });

    const scope = await resolveScope(u);
    const before = await prisma.item.findFirst({ where: { AND: [{ id: itemId }, itemWhere(scope)] }, select: ITEM_SELECT });
    if (!before) return res.status(403).json({ error: 'هذا الايتم خارج نطاق صلاحيتك.' });

    const body = req.body ?? {};
    const data = {};
    for (const f of TEXT_FIELDS) {
      if (body[f] === undefined) continue;
      const v = String(body[f] ?? '').replace(/\s+/g, ' ').trim();
      if (f === 'name') {
        if (!v) return res.status(400).json({ error: 'اسم الايتم لا يمكن أن يكون فارغاً.' });
        if (v.length > 200) return res.status(400).json({ error: 'الاسم طويل جداً.' });
      }
      const nv = v || null;
      if (nv !== (before[f] ?? null)) data[f] = f === 'name' ? v : nv;
    }
    for (const f of PRICE_FIELDS) {
      if (body[f] === undefined) continue;
      const n = parsePrice(body[f]);
      if (Number.isNaN(n)) return res.status(400).json({ error: `${FIELD_LABELS[f]} غير صالح.` });
      if (n !== (before[f] ?? null)) data[f] = n;
    }
    if (!Object.keys(data).length) return res.json({ success: true, data: before, changed: false });

    // إعادة التسمية: منع التكرار داخل الشركة، والاسم القديم يصير اسماً بديلاً
    // (ItemMergeRule) كي تبقى الملفات القادمة بالاسم القديم مرتبطة بنفس الايتم.
    const companyId = before.scientificCompanyId;
    if (data.name !== undefined) {
      const newKey = normalizeItemKey(data.name);
      if (newKey !== normalizeItemKey(before.name)) {
        const siblings = await prisma.item.findMany({
          where:  { scientificCompanyId: companyId, isTemp: false, id: { not: itemId } },
          select: { name: true },
        });
        if (siblings.some(s => normalizeItemKey(s.name) === newKey)) {
          return res.status(400).json({ error: 'يوجد ايتم بنفس الاسم في هذه الشركة.' });
        }
      }
    }

    const item = await prisma.item.update({ where: { id: itemId }, data, select: ITEM_SELECT });

    if (data.name !== undefined && companyId) {
      const oldKey = normalizeItemKey(before.name);
      if (oldKey && oldKey !== normalizeItemKey(item.name)) {
        try {
          await prisma.itemMergeRule.upsert({
            where:  { scientificCompanyId_fromKey: { scientificCompanyId: companyId, fromKey: oldKey } },
            update: { fromName: before.name, toName: item.name, toItemId: item.id },
            create: { scientificCompanyId: companyId, fromKey: oldKey, fromName: before.name, toName: item.name, toItemId: item.id, userId: u.id },
          });
        } catch (e) { console.warn('[items-catalog] rename alias failed (non-fatal):', e.message); }
      }
      // القواعد التي تشير لهذا الايتم تحمل اسمه للعرض فقط — نحدّثه
      await prisma.itemMergeRule.updateMany({ where: { toItemId: item.id }, data: { toName: item.name } }).catch(() => {});
    }

    const changes = Object.keys(data).map(f => ({ field: f, from: before[f] ?? null, to: item[f] ?? null }));
    await logChange(u.id, 'item_catalog_update', { itemId, itemName: item.name, companyId, changes });

    res.json({ success: true, data: item, changed: true });
  } catch (err) { next(err); }
}

// POST /api/items-catalog/items  { companyId, name, ... }
export async function createItem(req, res, next) {
  try {
    const u = await loadEditor(req, res); if (!u) return;
    const scope = await resolveScope(u);
    const body = req.body ?? {};
    const companyId = parseInt(body.companyId, 10);
    if (!scope.companyIds.includes(companyId)) return res.status(403).json({ error: 'لا يمكنك الإضافة لهذه الشركة.' });

    const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) return res.status(400).json({ error: 'اسم الايتم مطلوب.' });
    if (name.length > 200) return res.status(400).json({ error: 'الاسم طويل جداً.' });

    const key = normalizeItemKey(name);
    const siblings = await prisma.item.findMany({
      where: { scientificCompanyId: companyId, isTemp: false }, select: { id: true, name: true },
    });
    if (siblings.some(s => normalizeItemKey(s.name) === key)) {
      return res.status(400).json({ error: 'الايتم موجود مسبقاً في هذه الشركة.' });
    }

    const prices = {};
    for (const f of PRICE_FIELDS) {
      const n = parsePrice(body[f]);
      if (Number.isNaN(n)) return res.status(400).json({ error: `${FIELD_LABELS[f]} غير صالح.` });
      prices[f] = n;
    }
    const txt = f => String(body[f] ?? '').replace(/\s+/g, ' ').trim() || null;

    const item = await prisma.item.create({
      data: {
        name,
        scientificName: txt('scientificName'), dosage: txt('dosage'), form: txt('form'),
        scientificMessage: txt('scientificMessage'),
        ...prices,
        scientificCompanyId: companyId,
      },
      select: ITEM_SELECT,
    });

    // مدير بقائمة ايتمات محددة: الايتم الجديد يُضاف لقائمته وإلا لن يراه
    if (scope.itemIds) {
      await prisma.userItemAssignment.create({ data: { userId: u.id, itemId: item.id } }).catch(() => {});
    }

    await logChange(u.id, 'item_catalog_create', {
      itemId: item.id, itemName: item.name, companyId,
      changes: [...PRICE_FIELDS, 'scientificName', 'dosage', 'form']
        .filter(f => item[f] != null).map(f => ({ field: f, from: null, to: item[f] })),
    });

    res.status(201).json({ success: true, data: { ...item, lastEdit: null } });
  } catch (err) { next(err); }
}
