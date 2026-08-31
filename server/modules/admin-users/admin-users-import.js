/**
 * استيراد مستخدمين بالجملة من ملف إكسل — لوحة السوبر-أدمن (صفحة المستخدمون).
 * يدعم إنشاء عدة حسابات دفعة واحدة، كل حساب مع شركاته/ايتماته/محافظاته/مناطقه
 * الاختيارية، بنفس المنطق المستخدم في الإنشاء اليدوي (createUser + setUserX).
 *
 * شكل الملف — "كتلة" صفوف لكل مستخدم بدل حشر كل شيء بخلية واحدة (فاصلة بين
 * عشرات الأسماء كان بطيئاً ومعرضاً للخطأ): الصف الذي يحمل اسم مستخدم يبدأ
 * مستخدماً جديداً (هوية الحساب + أول شركة/ايتم/محافظة/منطقة له إن وُجدت)،
 * وأي صف تحته باسم مستخدم فارغ يُعتبر امتداداً لنفس المستخدم — عمود واحد
 * لكل قيمة إضافية (ايتم آخر، منطقة أخرى...). الشركة/المحافظة "تُورَّثان" نزولاً:
 * صف فارغ في عمود الشركة يعني "نفس آخر شركة مذكورة أعلاه ضمن نفس المستخدم" —
 * فايتم مذكور في صف تال لشركة ما يُطابَق مقابل كتالوج تلك الشركة تلقائياً.
 *
 * تدفّق العمل على مرحلتين (مطابق لنمط استيراد زيارات الأطباء):
 *   1) previewUsersImport — يقرأ الملف، يُقسّمه لكتل، يطابق كل حقل تلقائياً
 *      مقابل كتالوج المكتب (شركات/ايتمات) والقوائم العالمية (محافظات/مناطق)،
 *      ويُعيد كتلة لكل مستخدم للمراجعة — لا يُنشئ شيئاً.
 *   2) commitUsersImport — يأخذ الكتل بعد مراجعة المستخدم، وينشئ كل حساب +
 *      تعييناته فعلياً، واحداً تلو الآخر (فشل واحد لا يُسقط البقية).
 */

import bcrypt from 'bcryptjs';
import XLSX from 'xlsx';
import fs from 'fs';
import prisma from '../../lib/prisma.js';
import { normalizeArabic, normalizeItemKey, normalizeAreaName } from '../../lib/itemResolver.js';
import { syncUserAreaDerivedLinks } from '../../lib/areaScope.js';
import { buildDefaultPermissions } from './admin-users.controller.js';

// نفس قيم/تسميات ROLES في src/pages/super-admin/UsersPage.tsx — يقبل العمود
// "الدور" إما القيمة الخام (scientific_rep) أو التسمية العربية (مندوب علمي).
const ROLES = [
  { value: 'office_manager',          label: 'مدير مكتب' },
  { value: 'office_hr',               label: 'HR مكتب' },
  { value: 'office_employee',         label: 'موظف مكتب' },
  { value: 'company_manager',         label: 'مدير شركة' },
  { value: 'supervisor',              label: 'مشرف' },
  { value: 'product_manager',         label: 'مدير منتج' },
  { value: 'team_leader',             label: 'قائد فريق' },
  { value: 'scientific_rep',          label: 'مندوب علمي' },
  { value: 'commercial_supervisor',   label: 'مشرف تجاري' },
  { value: 'commercial_team_leader',  label: 'قائد فريق تجاري' },
  { value: 'commercial_rep',          label: 'مندوب تجاري' },
  { value: 'admin',                   label: 'مدير (admin)' },
  { value: 'manager',                 label: 'مدير (manager)' },
];
const ROLE_VALUES = new Set(ROLES.map(r => r.value));
function resolveRole(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: 'scientific_rep', matched: true };
  if (ROLE_VALUES.has(s)) return { value: s, matched: true };
  const byLabel = ROLES.find(r => r.label === s || normalizeArabic(r.label) === normalizeArabic(s));
  if (byLabel) return { value: byLabel.value, matched: true };
  return { value: 'scientific_rep', matched: false };
}

const COL_KEYWORDS = {
  username:    ['اسم المستخدم', 'اسم الدخول', 'يوزر', 'username'],
  password:    ['كلمة المرور', 'الباسورد', 'كلمة السر', 'password'],
  displayName: ['الاسم الظاهر', 'الاسم الكامل', 'الاسم', 'displayname', 'name'],
  phone:       ['رقم الهاتف', 'الهاتف', 'الموبايل', 'phone'],
  role:        ['الدور', 'الصلاحية', 'role'],
  company:     ['الشركة', 'company'],
  item:        ['الايتمات', 'الأيتمات', 'الايتم', 'المادة', 'items', 'item'],
  province:    ['المحافظة', 'province'],
  area:        ['المنطقة', 'المناطق', 'area'],
};

function findCol(headers, keywords) {
  const lower = headers.map(h => String(h).trim().toLowerCase());
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    let idx = lower.findIndex(h => h === k);
    if (idx === -1) idx = lower.findIndex(h => h.includes(k));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

export async function previewUsersImport(req, res) {
  try {
    const officeId = parseInt(req.body.officeId ?? req.query.officeId);
    if (!Number.isInteger(officeId)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'يجب اختيار المكتب أولاً' });
    }
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع أي ملف' });

    const workbook = XLSX.readFile(req.file.path);
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows  = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    fs.unlink(req.file.path, () => {});

    if (rawRows.length === 0) {
      return res.json({ success: true, data: { officeId, rows: [], summary: { total: 0, valid: 0, invalid: 0 } } });
    }

    const headers = Object.keys(rawRows[0]);
    const colMap  = {};
    for (const [field, kws] of Object.entries(COL_KEYWORDS)) colMap[field] = findCol(headers, kws);

    // كتالوج المكتب: شركاته وايتماتها (نطاق المطابقة).
    const companies = await prisma.scientificCompany.findMany({
      where: { officeId },
      select: { id: true, name: true, items: { where: { isTemp: false }, select: { id: true, name: true } } },
    });
    const companyByNorm = new Map(companies.map(c => [normalizeArabic(c.name), c]));

    // القوائم العالمية: محافظات ومناطق (نفس ما تعرضه شاشة تعيين المستخدم الحالية).
    const [allProvinces, allAreas, existingUsers] = await Promise.all([
      prisma.province.findMany({ select: { id: true, name: true } }),
      prisma.area.findMany({ select: { id: true, name: true } }),
      prisma.user.findMany({ select: { username: true } }),
    ]);
    const provinceByNorm = new Map(allProvinces.map(p => [normalizeArabic(p.name), p]));
    const areasByNorm = new Map();
    for (const a of allAreas) {
      const key = normalizeAreaName(a.name);
      if (!areasByNorm.has(key)) areasByNorm.set(key, []);
      areasByNorm.get(key).push(a);
    }
    const takenUsernames = new Set(existingUsers.map(u => u.username.toLowerCase()));
    const seenInFile = new Set();

    // ── تقسيم الصفوف إلى كتل: صف بعمود "اسم المستخدم" غير فارغ يبدأ كتلة جديدة؛
    // الصفوف الفارغة من اسم المستخدم بعده تنضم لنفس الكتلة حتى الكتلة التالية.
    const get = (raw, field) => (colMap[field] ? String(raw[colMap[field]] ?? '').trim() : '');
    const blocks = [];
    let current = null;
    let carryCompany = null; // آخر شركة صحيحة ذُكرت ضمن الكتلة الحالية (تُطبَّق على أي ايتم بلا شركة صريحة بنفس الصف)

    rawRows.forEach((raw, i) => {
      const excelRow = i + 2; // ١ = صف الترويسة
      const username = get(raw, 'username');
      if (username) {
        current = {
          startRow: excelRow, endRow: excelRow,
          username, password: get(raw, 'password'), displayName: get(raw, 'displayName'), phone: get(raw, 'phone'),
          roleRaw: get(raw, 'role'),
          companyIds: [], companyNames: [],
          itemIds: [], itemNames: [],
          provinceIds: [], provinceNames: [],
          areaIds: [], areaNames: [],
          unmatchedCompanies: [], unmatchedItems: [], unmatchedProvinces: [], unmatchedAreas: [],
        };
        blocks.push(current);
        carryCompany = null;
      }
      if (!current) return; // صفوف قبل أي اسم مستخدم (مثال متروك في الأعلى) — تُتجاهل بصمت

      current.endRow = excelRow;

      const companyRaw = get(raw, 'company');
      if (companyRaw) {
        const found = companyByNorm.get(normalizeArabic(companyRaw));
        if (found) {
          carryCompany = found;
          if (!current.companyIds.includes(found.id)) { current.companyIds.push(found.id); current.companyNames.push(found.name); }
        } else {
          carryCompany = null;
          current.unmatchedCompanies.push(companyRaw);
        }
      }

      const itemRaw = get(raw, 'item');
      if (itemRaw) {
        if (!carryCompany) {
          current.unmatchedItems.push(`${itemRaw} (بلا شركة صحيحة في هذا الصف أو ما فوقه)`);
        } else {
          const itemByKey = new Map(carryCompany.items.map(it => [normalizeItemKey(it.name), it]));
          const found = itemByKey.get(normalizeItemKey(itemRaw));
          if (found) {
            if (!current.itemIds.includes(found.id)) { current.itemIds.push(found.id); current.itemNames.push(found.name); }
          } else {
            current.unmatchedItems.push(`${itemRaw} (${carryCompany.name})`);
          }
        }
      }

      const provinceRaw = get(raw, 'province');
      if (provinceRaw) {
        const found = provinceByNorm.get(normalizeArabic(provinceRaw));
        if (found) {
          if (!current.provinceIds.includes(found.id)) { current.provinceIds.push(found.id); current.provinceNames.push(found.name); }
        } else {
          current.unmatchedProvinces.push(provinceRaw);
        }
      }

      const areaRaw = get(raw, 'area');
      if (areaRaw) {
        const found = areasByNorm.get(normalizeAreaName(areaRaw));
        if (found?.length) {
          for (const a of found) if (!current.areaIds.includes(a.id)) current.areaIds.push(a.id);
          if (!current.areaNames.includes(found[0].name)) current.areaNames.push(found[0].name);
        } else {
          current.unmatchedAreas.push(areaRaw);
        }
      }
    });

    const rows = blocks.map(b => {
      const errors = [];
      const warnings = [];

      if (!b.username) errors.push('اسم المستخدم مطلوب');
      if (!b.password) errors.push('كلمة المرور مطلوبة');
      if (b.username) {
        const lower = b.username.toLowerCase();
        if (takenUsernames.has(lower)) errors.push('اسم المستخدم مستخدم مسبقاً');
        else if (seenInFile.has(lower)) errors.push('اسم المستخدم مكرر في نفس الملف');
        seenInFile.add(lower);
      }

      const { value: role, matched: roleMatched } = resolveRole(b.roleRaw);
      if (!roleMatched) warnings.push(`الدور "${b.roleRaw}" غير معروف — تم استخدام "مندوب علمي" افتراضياً`);
      if (b.unmatchedCompanies.length) warnings.push(`شركات غير موجودة ضمن كتالوج هذا المكتب: ${b.unmatchedCompanies.join('، ')}`);
      if (b.unmatchedItems.length) warnings.push(`ايتمات غير معروفة: ${b.unmatchedItems.join('، ')}`);
      if (b.unmatchedProvinces.length) warnings.push(`محافظات غير معروفة: ${b.unmatchedProvinces.join('، ')}`);
      if (b.unmatchedAreas.length) warnings.push(`مناطق غير معروفة: ${b.unmatchedAreas.join('، ')}`);

      return {
        rowIndex: b.startRow,
        rowRange: b.endRow > b.startRow ? `${b.startRow}-${b.endRow}` : String(b.startRow),
        username: b.username, password: b.password, displayName: b.displayName, phone: b.phone, role,
        companyIds: b.companyIds, companyNames: b.companyNames,
        primaryCompanyId: b.companyIds[0] ?? null,
        itemIds: b.itemIds, itemNames: b.itemNames,
        provinceIds: b.provinceIds, provinceNames: b.provinceNames,
        areaIds: b.areaIds, areaNames: b.areaNames,
        errors, warnings,
      };
    });

    const valid = rows.filter(r => r.errors.length === 0).length;
    res.json({
      success: true,
      data: { officeId, rows, summary: { total: rows.length, valid, invalid: rows.length - valid } },
    });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    console.error('[previewUsersImport] failed:', err);
    res.status(500).json({ error: 'فشل قراءة الملف — تأكد أنه بصيغة إكسل صحيحة.' });
  }
}

export async function commitUsersImport(req, res) {
  const officeId = parseInt(req.body.officeId);
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!Number.isInteger(officeId)) return res.status(400).json({ error: 'معرّف مكتب غير صالح' });

  const created = [];
  const failed = [];

  for (const row of rows) {
    const {
      rowIndex, username, password, displayName, phone, role,
      companyIds, primaryCompanyId, itemIds, provinceIds, areaIds,
    } = row;
    try {
      if (!username || !password) throw new Error('اسم المستخدم وكلمة المرور مطلوبان');
      const exists = await prisma.user.findUnique({ where: { username } });
      if (exists) throw new Error('اسم المستخدم مستخدم مسبقاً');

      const passwordHash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: {
          username, passwordHash, displayName: displayName || null, phone: phone || null,
          role: ROLE_VALUES.has(role) ? role : 'scientific_rep',
          officeId,
          permissions: JSON.stringify(buildDefaultPermissions()),
        },
        select: { id: true },
      });

      if (Array.isArray(companyIds) && companyIds.length) {
        await prisma.userCompanyAssignment.createMany({
          data: companyIds.map(companyId => ({ userId: user.id, companyId, isPrimary: companyId === primaryCompanyId })),
          skipDuplicates: true,
        });
      }
      if (Array.isArray(itemIds) && itemIds.length) {
        await prisma.userItemAssignment.createMany({
          data: itemIds.map(itemId => ({ userId: user.id, itemId })),
          skipDuplicates: true,
        });
      }
      if (Array.isArray(provinceIds) && provinceIds.length) {
        await prisma.userProvinceAssignment.createMany({
          data: provinceIds.map(provinceId => ({ userId: user.id, provinceId })),
          skipDuplicates: true,
        });
      }
      if (Array.isArray(areaIds) && areaIds.length) {
        await prisma.userAreaAssignment.createMany({
          data: areaIds.map(areaId => ({ userId: user.id, areaId })),
          skipDuplicates: true,
        });
      }
      if ((Array.isArray(provinceIds) && provinceIds.length) || (Array.isArray(areaIds) && areaIds.length)) {
        try { await syncUserAreaDerivedLinks(user.id); }
        catch (e) { console.warn('[commitUsersImport] derived-link sync failed (non-fatal):', e.message); }
      }

      created.push({ rowIndex, username, userId: user.id });
    } catch (err) {
      failed.push({ rowIndex, username, error: err.message ?? 'فشل غير معروف' });
    }
  }

  res.json({ success: true, data: { created, failed } });
}
