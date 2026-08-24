import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma.js';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import { syncUserAreaDerivedLinks, resolveEffectiveAreaIds } from '../../lib/areaScope.js';

const userSelect = {
  id: true, username: true, displayName: true, role: true,
  isActive: true, phone: true, permissions: true, officeId: true,
  linkedRepId: true,
  createdAt: true,
  office: { select: { id: true, name: true } },
  linkedRep: { select: { id: true, name: true } },
  companyAssignments: { include: { company: { select: { id: true, name: true } } } },
  lineAssignments:    { include: { line:    { select: { id: true, name: true, companyId: true } } } },
  itemAssignments:    { include: { item:    { select: { id: true, name: true } } } },
  areaAssignments:    { include: { area:    { select: { id: true, name: true } } } },
  provinceAssignments: { include: { province: { select: { id: true, name: true } } } },
  subProvinceAssignments: { include: { subProvince: { select: { id: true, name: true, provinceId: true } } } },
  managersOfUser:     { include: { manager: { select: { id: true, username: true, displayName: true } } } },
  subordinatesOfUser: { include: { user:    { select: { id: true, username: true, displayName: true } } } },
  interactionAsActor: { include: { target:  { select: { id: true, username: true, displayName: true } } } },
};

// ── List all users ────────────────────────────────────────────────────────
export async function listAllUsers(req, res) {
  const { officeId, role, isActive } = req.query;
  const where = {};
  if (officeId) where.officeId = parseInt(officeId);
  if (role)     where.role     = role;
  if (isActive !== undefined) where.isActive = isActive === 'true';

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true, username: true, displayName: true, role: true,
      isActive: true, phone: true, officeId: true, linkedRepId: true,
      office: { select: { id: true, name: true } },
      _count: { select: { companyAssignments: true, doctorVisits: true } },
      companyAssignments: { include: { company: { select: { id: true, name: true } } } },
      managersOfUser:     { include: { manager: { select: { id: true, username: true, displayName: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: users });
}

// ── Get single user with full details ─────────────────────────────────────
export async function getUser(req, res) {
  const id = parseInt(req.params.id);
  const user = await prisma.user.findUnique({ where: { id }, select: userSelect });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, data: user });
}

// ── Create user ───────────────────────────────────────────────────────────
// Features disabled by default for every new user — master admin can re-enable them
const DEFAULT_DISABLED_FEATURES = ['rep_analysis', 'sales_data', 'distributor_sales', 'users_list'];

export async function createUser(req, res) {
  const { username, password, displayName, role = 'scientific_rep', officeId, phone, permissions } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const exists = await prisma.user.findUnique({ where: { username } });
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  // Build default permissions — merge caller-supplied with defaults
  const defaultPerms = { disabledFeatures: DEFAULT_DISABLED_FEATURES, requireGps: true };
  const mergedPerms = permissions
    ? { ...defaultPerms, ...permissions }
    : defaultPerms;

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash,
      displayName,
      role,
      phone,
      officeId: officeId ? parseInt(officeId) : null,
      permissions: JSON.stringify(mergedPerms),
    },
    select: userSelect,
  });
  res.status(201).json({ success: true, data: user });
}

// ── Update user ───────────────────────────────────────────────────────────
export async function updateUser(req, res) {
  try {
    const id = parseInt(req.params.id);
    const { username, displayName, role, isActive, phone, officeId, permissions, password, linkedRepId } = req.body;

    const data = {};
    if (username     !== undefined) data.username    = username;
    if (displayName  !== undefined) data.displayName = displayName;
    if (role         !== undefined) data.role        = role;
    if (isActive     !== undefined) data.isActive    = Boolean(isActive);
    if (phone        !== undefined) data.phone       = phone;
    if (officeId     !== undefined) data.officeId    = officeId ? parseInt(officeId) : null;
    if (permissions  !== undefined) data.permissions = JSON.stringify(permissions);
    if (password)                   data.passwordHash = await bcrypt.hash(password, 12);
    if (linkedRepId !== undefined)  data.linkedRepId  = linkedRepId ? parseInt(linkedRepId) : null;

    const user = await prisma.user.update({ where: { id }, data, select: userSelect });

    // Keep the linked ScientificRepresentative record(s) in sync. That row's `name`
    // is only set ONCE at auto-creation (from displayName/username) — reports/exports
    // read it directly and never re-derive it from User.displayName afterwards, so a
    // rename here would otherwise silently go stale in every report/Excel export.
    if (displayName !== undefined) {
      await prisma.scientificRepresentative.updateMany({
        where: { userId: id },
        data: { name: displayName || user.username },
      });
    }

    res.json({ success: true, data: user });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل.' });
    res.status(500).json({ error: err.message });
  }
}

// ── Rep diagnostic: show all ScientificRepresentative records for a user ─
export async function getUserRepInfo(req, res) {
  const id = parseInt(req.params.id);
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, displayName: true, linkedRepId: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  // All ScientificRepresentative records with userId = this user
  const repsByUserId = await prisma.scientificRepresentative.findMany({
    where: { userId: id },
    select: {
      id: true, name: true, isActive: true, createdAt: true,
      _count: { select: { doctorVisits: true, pharmacyVisits: true } },
    },
  });

  // The currently linked rep (via linkedRepId)
  let linkedRep = null;
  if (user.linkedRepId) {
    linkedRep = await prisma.scientificRepresentative.findUnique({
      where: { id: user.linkedRepId },
      select: {
        id: true, name: true, isActive: true, userId: true,
        _count: { select: { doctorVisits: true, pharmacyVisits: true } },
      },
    });
  }

  res.json({ success: true, data: { user, linkedRep, repsByUserId } });
}

// ── Items of the user's assigned scientific companies ──────────────────────
// يغذّي تبويب «الايتمات» في صفحة المستخدم: كل ايتمات كتالوج الشركات المعيّنة له
// (Item.scientificCompanyId ∈ شركات المستخدم، isTemp=false)، مجمّعة بمعلومة الشركة.
// المشرف يختار منها القائمة البيضاء (UserItemAssignment)؛ إن لم يختر شيئاً يعمل
// المستخدم على كل هذه الايتمات (السلوك الافتراضي — يُطبَّق في /api/items و getMySharedItems).
export async function getUserCompanyItems(req, res) {
  const userId = parseInt(req.params.id);

  // ?companyIds=1,2,3 ← معاينة فورية لايتمات اختيارٍ لم يُحفظ بعد في تبويب «الشركات».
  // بدونه يعود لسلوكه الأصلي: ايتمات الشركات المحفوظة فعلاً للمستخدم.
  const rawQ = req.query.companyIds;
  const override = typeof rawQ === 'string' && rawQ.trim().length > 0
    ? [...new Set(rawQ.split(',').map(n => parseInt(n)).filter(Number.isInteger))]
    : null;

  let companyIds;
  if (override) {
    companyIds = override;
  } else {
    const companies = await prisma.userCompanyAssignment.findMany({
      where: { userId },
      select: { companyId: true },
    });
    companyIds = companies.map(c => c.companyId);
  }
  if (companyIds.length === 0) return res.json({ success: true, data: [] });

  const items = await prisma.item.findMany({
    where: { scientificCompanyId: { in: companyIds }, isTemp: false },
    select: {
      id: true, name: true, scientificCompanyId: true,
      scientificCompany: { select: { id: true, name: true } },
    },
    orderBy: [{ scientificCompanyId: 'asc' }, { name: 'asc' }],
  });
  const data = items.map(i => ({
    id: i.id,
    name: i.name,
    companyId: i.scientificCompanyId,
    companyName: i.scientificCompany?.name ?? '—',
  }));
  res.json({ success: true, data });
}

// ── Delete user ───────────────────────────────────────────────────────────
export async function deleteUser(req, res) {
  const id = parseInt(req.params.id);
  const force = req.query.force === '1' || req.query.force === 'true';
  try {
    if (force) {
      // Force delete: remove the user's activity data that blocks deletion at the DB
      // level (the RESTRICT relations named in the error below), then the user.
      // Their CASCADE children (plan entries/comments, invoice items, collections,
      // visit likes/comments…) go automatically. SET NULL relations (sales, uploaded
      // files, and shared/reference entities like items/doctors/pharmacies/areas) are
      // auto-nulled by the DB — kept intact so other users' reports aren't broken.
      // Order matters: rows that point AT the user directly first, then the parents
      // the user owns (whose remaining cascade-children then clear).
      await prisma.$transaction([
        prisma.visitLike.deleteMany({ where: { userId: id } }),
        prisma.visitComment.deleteMany({ where: { userId: id } }),
        prisma.pharmacyVisitLike.deleteMany({ where: { userId: id } }),
        prisma.dailyPlanComment.deleteMany({ where: { userId: id } }),
        prisma.dailyPlanSettings.deleteMany({ where: { userId: id } }),
        prisma.collectionRecord.deleteMany({ where: { collectedById: id } }),
        prisma.commercialInvoice.deleteMany({ where: { OR: [{ createdByUserId: id }, { assignedRepId: id }] } }),
        prisma.invoiceSheet.deleteMany({ where: { repId: id } }),
        prisma.dailyPlan.deleteMany({ where: { userId: id } }),
        prisma.user.delete({ where: { id } }),
      ]);
      return res.json({ success: true, forced: true });
    }
    await prisma.user.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'المستخدم غير موجود أو تم حذفه بالفعل.' });
    }
    // Postgres FK RESTRICT violation (bubbles up from onDelete-default relations
    // like DailyPlan, InvoiceSheet, CommercialInvoice, CollectionRecord, VisitLike/
    // VisitComment): the user has activity data that blocks deletion at the DB level.
    if (err.code === 'P2003' || err.code === 'P2014' || /foreign key constraint/i.test(err.message || '')) {
      return res.status(409).json({
        error: 'لا يمكن حذف هذا المستخدم لأن لديه بيانات مرتبطة (بلان يومي، فواتير تجارية، كشوفات استحصال، أو إعجابات/تعليقات على زيارات). عطّل الحساب بدلاً من حذفه إذا أردت إيقافه دون فقدان هذه البيانات.',
        code: 'HAS_DEPENDENCIES',
      });
    }
    console.error('[deleteUser] failed:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء حذف المستخدم.' });
  }
}

// ── Set user companies (replace all) ─────────────────────────────────────
// primaryCompanyId يحدد الشركة الرئيسية (تكوين التيم/الهيكل على أساسها). رئيسية
// واحدة فقط؛ إن لم تُرسَل أو لم تكن ضمن القائمة → الأولى تصبح رئيسية.
export async function setUserCompanies(req, res) {
  const userId = parseInt(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });

  const raw = Array.isArray(req.body?.companyIds) ? req.body.companyIds : [];
  // تطهير المدخلات: أي تكرار في companyIds كان يضرب المفتاح المركّب (userId, companyId)
  // فيُلغي الـtransaction كاملاً ويضيع الحفظ دون رسالة خطأ واضحة.
  const requested = [...new Set(raw.map(id => parseInt(id)).filter(Number.isInteger))];

  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    // تجاهل أي شركة محذوفة بدل إسقاط الحفظ كله بخطأ مفتاح أجنبي
    const found = requested.length
      ? await prisma.scientificCompany.findMany({ where: { id: { in: requested } }, select: { id: true } })
      : [];
    const validSet = new Set(found.map(c => c.id));
    const ids = requested.filter(id => validSet.has(id));
    const dropped = requested.filter(id => !validSet.has(id));

    let primaryId = req.body?.primaryCompanyId != null ? parseInt(req.body.primaryCompanyId) : null;
    if (!Number.isInteger(primaryId) || !ids.includes(primaryId)) primaryId = ids[0] ?? null; // fallback: الأولى

    await prisma.$transaction([
      prisma.userCompanyAssignment.deleteMany({ where: { userId } }),
      ...(ids.length ? [prisma.userCompanyAssignment.createMany({
        data: ids.map(id => ({ userId, companyId: id, isPrimary: id === primaryId })),
        skipDuplicates: true,
      })] : []),
    ]);

    // نقرأ المحفوظ فعلاً ونُرجعه للواجهة لتتحقق من النتيجة (لا تكتفي بـ success)
    const saved = await prisma.userCompanyAssignment.findMany({
      where: { userId },
      select: { companyId: true, isPrimary: true },
    });
    res.json({
      success: true,
      data: saved.map(a => ({ companyId: a.companyId, isPrimary: a.isPrimary })),
      primaryCompanyId: saved.find(a => a.isPrimary)?.companyId ?? null,
      dropped,
    });
  } catch (err) {
    console.error('[setUserCompanies] failed for user', userId, err);
    res.status(500).json({ error: 'فشل حفظ الشركات — لم يتغيّر شيء. حاول مرة أخرى.' });
  }
}

// ── Set user areas ────────────────────────────────────────────────────────
export async function setUserAreas(req, res) {
  const userId = parseInt(req.params.id);
  const { areaIds = [] } = req.body;
  const parsedAreaIds = areaIds.map(id => parseInt(id));

  // Resolve area IDs: if this user has a manager, also include the equivalent areas
  // from the manager's account using fuzzy Arabic name matching (handles ة/ه, حي prefix, etc.)
  let finalAreaIds = [...parsedAreaIds];
  try {
    const managerRows = await prisma.userManagerAssignment.findMany({
      where: { userId },
      select: { managerId: true },
    });
    const managerIds = managerRows.map(r => r.managerId);
    if (managerIds.length > 0 && parsedAreaIds.length > 0) {
      const normA = normalizeAreaName;

      const chosenAreas = await prisma.area.findMany({
        where: { id: { in: parsedAreaIds } },
        select: { id: true, name: true },
      });
      const allManagerAreas = await prisma.area.findMany({
        where: { userId: { in: managerIds } },
        select: { id: true, name: true },
      });
      const extraIds = [];
      for (const chosen of chosenAreas) {
        const cN = normA(chosen.name);
        // Inherit the manager's equivalent area ONLY on an exact normalised match.
        // Substring matching (includes) was too loose — e.g. «الحسينية» (norm: الحسينيه)
        // matched «حي الحسين» (norm: الحسين), so the manager's «حي الحسين» kept getting
        // re-added on every save even after the admin explicitly removed it.
        const match = allManagerAreas.find(m => normA(m.name) === cN);
        if (match) extraIds.push(match.id);
      }
      finalAreaIds = [...new Set([...parsedAreaIds, ...extraIds])];
    }
  } catch (e) {
    console.warn('[setUserAreas] manager area resolution failed (non-fatal):', e.message);
    finalAreaIds = parsedAreaIds;
  }

  // Save user area assignments
  await prisma.$transaction([
    prisma.userAreaAssignment.deleteMany({ where: { userId } }),
    ...(finalAreaIds.length ? [prisma.userAreaAssignment.createMany({
      data: finalAreaIds.map(areaId => ({ userId, areaId })),
    })] : []),
  ]);

  // مزامنة الروابط المشتقة (ScientificRepArea + ScientificRepCommercial).
  // نُقلت إلى areaScope.js لأن تعيين المحافظات صار مُشغّلاً ثانياً لها، ورفعُ
  // ملفٍ يُنشئ مناطق داخل محافظة معيَّنة مُشغّلاً ثالثاً.
  try {
    await syncUserAreaDerivedLinks(userId);
  } catch (e) {
    console.warn('[setUserAreas] ScientificRepArea/commercial sync failed (non-fatal):', e.message);
  }

  res.json({ success: true });
}

// ── Set user provinces (المحافظات) ────────────────────────────────────────
// تعيين محافظة = كل مناطقها ضمنياً، الآن ومستقبلاً. لا نُسطِّحها إلى صفوف
// UserAreaAssignment: التسطيح يجمّد القائمة عند لحظة الحفظ، فتغيب أي منطقة
// تدخل المحافظة لاحقاً. التوسيع يحدث وقت الاستعلام في areaScope.js.
export async function setUserProvinces(req, res) {
  const userId = parseInt(req.params.id);
  const { provinceIds = [] } = req.body;
  const ids = [...new Set(provinceIds.map(Number).filter(Number.isInteger))];

  const existing = ids.length
    ? await prisma.province.findMany({ where: { id: { in: ids } }, select: { id: true } })
    : [];
  const validIds = existing.map(p => p.id);

  await prisma.$transaction([
    prisma.userProvinceAssignment.deleteMany({ where: { userId } }),
    ...(validIds.length ? [prisma.userProvinceAssignment.createMany({
      data: validIds.map(provinceId => ({ userId, provinceId })),
      skipDuplicates: true,
    })] : []),
  ]);

  // الروابط المشتقة لقطات — يجب إعادة بنائها لأن نطاق المناطق تغيّر
  try {
    await syncUserAreaDerivedLinks(userId);
  } catch (e) {
    console.warn('[setUserProvinces] derived-link sync failed (non-fatal):', e.message);
  }

  const effectiveAreaIds = await resolveEffectiveAreaIds(userId);
  res.json({ success: true, provinceIds: validIds, effectiveAreaCount: effectiveAreaIds.length });
}

// ── Set user sub-provinces (أقسام المحافظة: الكرخ/الرصافة) ────────────────
// نفس منطق المحافظات: تعيين قسم = كل مناطقه ضمنياً الآن ومستقبلاً، والتوسيع
// وقت الاستعلام في areaScope.js — فلا نُسطّحه إلى صفوف UserAreaAssignment.
export async function setUserSubProvinces(req, res) {
  const userId = parseInt(req.params.id);
  const { subProvinceIds = [] } = req.body;
  const ids = [...new Set(subProvinceIds.map(Number).filter(Number.isInteger))];

  const existing = ids.length
    ? await prisma.subProvince.findMany({ where: { id: { in: ids } }, select: { id: true } })
    : [];
  const validIds = existing.map(s => s.id);

  await prisma.$transaction([
    prisma.userSubProvinceAssignment.deleteMany({ where: { userId } }),
    ...(validIds.length ? [prisma.userSubProvinceAssignment.createMany({
      data: validIds.map(subProvinceId => ({ userId, subProvinceId })),
      skipDuplicates: true,
    })] : []),
  ]);

  try {
    await syncUserAreaDerivedLinks(userId);
  } catch (e) {
    console.warn('[setUserSubProvinces] derived-link sync failed (non-fatal):', e.message);
  }

  const effectiveAreaIds = await resolveEffectiveAreaIds(userId);
  res.json({ success: true, subProvinceIds: validIds, effectiveAreaCount: effectiveAreaIds.length });
}

// ── Set user items ────────────────────────────────────────────────────────
export async function setUserItems(req, res) {
  const userId = parseInt(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });

  const raw = Array.isArray(req.body?.itemIds) ? req.body.itemIds : [];
  const requested = [...new Set(raw.map(id => parseInt(id)).filter(Number.isInteger))];

  try {
    // ايتم محذوف في القائمة كان يُسقط عملية الحفظ بأكملها (FK)
    const found = requested.length
      ? await prisma.item.findMany({ where: { id: { in: requested } }, select: { id: true } })
      : [];
    const validSet = new Set(found.map(i => i.id));
    const ids = requested.filter(id => validSet.has(id));
    const dropped = requested.filter(id => !validSet.has(id));

    await prisma.$transaction([
      prisma.userItemAssignment.deleteMany({ where: { userId } }),
      ...(ids.length ? [prisma.userItemAssignment.createMany({
        data: ids.map(id => ({ userId, itemId: id })),
        skipDuplicates: true,
      })] : []),
    ]);

    const saved = await prisma.userItemAssignment.findMany({ where: { userId }, select: { itemId: true } });
    res.json({ success: true, data: saved.map(a => a.itemId), dropped });
  } catch (err) {
    console.error('[setUserItems] failed for user', userId, err);
    res.status(500).json({ error: 'فشل حفظ الايتمات — لم يتغيّر شيء. حاول مرة أخرى.' });
  }
}

// ── Set user lines ────────────────────────────────────────────────────────
export async function setUserLines(req, res) {
  const userId = parseInt(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });

  const raw = Array.isArray(req.body?.lineIds) ? req.body.lineIds : [];
  const requested = [...new Set(raw.map(id => parseInt(id)).filter(Number.isInteger))];

  try {
    const found = requested.length
      ? await prisma.productLine.findMany({ where: { id: { in: requested } }, select: { id: true } })
      : [];
    const validSet = new Set(found.map(l => l.id));
    const ids = requested.filter(id => validSet.has(id));
    const dropped = requested.filter(id => !validSet.has(id));

    await prisma.$transaction([
      prisma.userLineAssignment.deleteMany({ where: { userId } }),
      ...(ids.length ? [prisma.userLineAssignment.createMany({
        data: ids.map(id => ({ userId, lineId: id })),
        skipDuplicates: true,
      })] : []),
    ]);

    const saved = await prisma.userLineAssignment.findMany({ where: { userId }, select: { lineId: true } });
    res.json({ success: true, data: saved.map(a => a.lineId), dropped });
  } catch (err) {
    console.error('[setUserLines] failed for user', userId, err);
    res.status(500).json({ error: 'فشل حفظ اللاينات — لم يتغيّر شيء. حاول مرة أخرى.' });
  }
}

// ── Set user managers ─────────────────────────────────────────────────────
export async function setUserManagers(req, res) {
  const userId = parseInt(req.params.id);
  const { managerIds = [] } = req.body;

  await prisma.$transaction([
    prisma.userManagerAssignment.deleteMany({ where: { userId } }),
    prisma.userManagerAssignment.createMany({
      data: managerIds.map(id => ({ userId, managerId: parseInt(id) })),
    }),
  ]);
  res.json({ success: true });
}

// ── Set user features (enable/disable per-user features) ────────────────────
export async function setUserFeatures(req, res) {
  const id = parseInt(req.params.id);
  const { disabledFeatures = [], requireGps, disableActivityLog, doctorFilterByArea, doctorFilterPlanMode, doctorFilterSurveyOnly } = req.body;

  const existing = await prisma.user.findUnique({ where: { id }, select: { permissions: true } });
  if (!existing) return res.status(404).json({ error: 'User not found' });

  let perms = {};
  try { perms = JSON.parse(existing.permissions || '{}'); } catch {}
  perms.disabledFeatures = disabledFeatures;
  if (requireGps !== undefined) perms.requireGps = Boolean(requireGps);
  if (disableActivityLog !== undefined) perms.disableActivityLog = Boolean(disableActivityLog);
  if (doctorFilterByArea !== undefined)     perms.doctorFilterByArea     = Boolean(doctorFilterByArea);
  if (doctorFilterPlanMode !== undefined)   perms.doctorFilterPlanMode   = String(doctorFilterPlanMode);
  if (doctorFilterSurveyOnly !== undefined) perms.doctorFilterSurveyOnly = Boolean(doctorFilterSurveyOnly);

  const user = await prisma.user.update({
    where: { id },
    data: { permissions: JSON.stringify(perms) },
    select: { id: true, permissions: true },
  });
  res.json({ success: true, data: user });
}

// ── Set interaction permissions ───────────────────────────────────────────
// actorId = req.params.id, targetIds = who they can interact with
export async function setUserInteractions(req, res) {
  const actorId = parseInt(req.params.id);
  const { targets = [] } = req.body;
  // targets: [{ targetId, canTypes: ["orders","reports",...] }, ...]

  await prisma.userInteractionPermission.deleteMany({ where: { actorId } });

  if (targets.length > 0) {
    await prisma.userInteractionPermission.createMany({
      data: targets.map(t => ({
        actorId,
        targetId: parseInt(t.targetId),
        canTypes: JSON.stringify(t.canTypes || []),
      })),
    });
  }
  res.json({ success: true });
}
