/**
 * استيراد مستخدمين بالجملة من ملف إكسل — لوحة السوبر-أدمن (صفحة المستخدمون).
 * يدعم إنشاء عدة حسابات دفعة واحدة، كل حساب مع شركته/ايتماته/محافظته/مناطقه
 * الاختيارية، بنفس المنطق المستخدم في الإنشاء اليدوي (createUser + setUserX).
 *
 * تدفّق العمل على مرحلتين (مطابق لنمط استيراد زيارات الأطباء):
 *   1) previewUsersImport — يقرأ الملف، يطابق كل حقل تلقائياً مقابل كتالوج
 *      المكتب (شركات/ايتمات) والقوائم العالمية (محافظات/مناطق)، ويُعيد الصفوف
 *      للمراجعة مع أخطاء (تمنع الاستيراد) وتحذيرات (لا تمنعه) — لا يُنشئ شيئاً.
 *   2) commitUsersImport — يأخذ الصفوف بعد مراجعة المستخدم، وينشئ كل حساب +
 *      تعييناته فعلياً، صفاً صفاً (فشل صف واحد لا يُسقط البقية).
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
  items:       ['الايتمات', 'الأيتمات', 'المواد', 'items'],
  province:    ['المحافظة', 'province'],
  area:        ['المنطقة', 'المناطق', 'area', 'areas'],
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

// يفصل قائمة أسماء داخل خلية واحدة — فاصلة عربية/إنكليزية أو فاصلة منقوطة أو سطر جديد.
function splitNames(raw) {
  return String(raw ?? '')
    .split(/[,،؛;\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
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

    const rows = rawRows.map((raw, i) => {
      const get = field => (colMap[field] ? String(raw[colMap[field]] ?? '').trim() : '');
      const errors = [];
      const warnings = [];

      const username = get('username');
      const password = get('password');
      if (!username) errors.push('اسم المستخدم مطلوب');
      if (!password) errors.push('كلمة المرور مطلوبة');
      if (username) {
        const lower = username.toLowerCase();
        if (takenUsernames.has(lower)) errors.push('اسم المستخدم مستخدم مسبقاً');
        else if (seenInFile.has(lower)) errors.push('اسم المستخدم مكرر في نفس الملف');
        seenInFile.add(lower);
      }

      const { value: role, matched: roleMatched } = resolveRole(get('role'));
      if (!roleMatched) warnings.push(`الدور "${get('role')}" غير معروف — تم استخدام "مندوب علمي" افتراضياً`);

      let companyId = null, companyName = '';
      const companyRaw = get('company');
      if (companyRaw) {
        const found = companyByNorm.get(normalizeArabic(companyRaw));
        if (found) { companyId = found.id; companyName = found.name; }
        else warnings.push(`الشركة "${companyRaw}" غير موجودة ضمن كتالوج هذا المكتب — لن تُربط أي شركة`);
      }

      let itemIds = [], itemNames = [];
      const itemsRaw = splitNames(get('items'));
      if (itemsRaw.length) {
        if (!companyId) {
          warnings.push('تم تجاهل الايتمات — لا يمكن مطابقتها بدون شركة صحيحة');
        } else {
          const company = companies.find(c => c.id === companyId);
          const itemByKey = new Map(company.items.map(it => [normalizeItemKey(it.name), it]));
          const unmatched = [];
          for (const name of itemsRaw) {
            const found = itemByKey.get(normalizeItemKey(name));
            if (found) { itemIds.push(found.id); itemNames.push(found.name); }
            else unmatched.push(name);
          }
          if (unmatched.length) warnings.push(`ايتمات غير معروفة لدى هذه الشركة: ${unmatched.join('، ')}`);
        }
      }

      let provinceId = null, provinceName = '';
      const provinceRaw = get('province');
      if (provinceRaw) {
        const found = provinceByNorm.get(normalizeArabic(provinceRaw));
        if (found) { provinceId = found.id; provinceName = found.name; }
        else warnings.push(`المحافظة "${provinceRaw}" غير معروفة`);
      }

      let areaIds = [], areaNames = [];
      const areasRaw = splitNames(get('area'));
      if (areasRaw.length) {
        const unmatched = [];
        for (const name of areasRaw) {
          const found = areasByNorm.get(normalizeAreaName(name));
          if (found?.length) { for (const a of found) areaIds.push(a.id); areaNames.push(found[0].name); }
          else unmatched.push(name);
        }
        if (unmatched.length) warnings.push(`مناطق غير معروفة: ${unmatched.join('، ')}`);
      }

      return {
        rowIndex: i + 2, // رقم صف الإكسل الفعلي (١ = ترويسة)
        username, password, displayName: get('displayName'), phone: get('phone'),
        role, companyId, companyName, itemIds: [...new Set(itemIds)], itemNames,
        provinceId, provinceName, areaIds: [...new Set(areaIds)], areaNames,
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
    const { rowIndex, username, password, displayName, phone, role, companyId, itemIds, provinceId, areaIds } = row;
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

      if (companyId) {
        await prisma.userCompanyAssignment.create({
          data: { userId: user.id, companyId, isPrimary: true },
        });
      }
      if (Array.isArray(itemIds) && itemIds.length) {
        await prisma.userItemAssignment.createMany({
          data: itemIds.map(itemId => ({ userId: user.id, itemId })),
          skipDuplicates: true,
        });
      }
      if (provinceId) {
        await prisma.userProvinceAssignment.create({
          data: { userId: user.id, provinceId },
        });
      }
      if (Array.isArray(areaIds) && areaIds.length) {
        await prisma.userAreaAssignment.createMany({
          data: areaIds.map(areaId => ({ userId: user.id, areaId })),
          skipDuplicates: true,
        });
      }
      if (provinceId || (Array.isArray(areaIds) && areaIds.length)) {
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
