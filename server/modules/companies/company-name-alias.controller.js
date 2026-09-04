// ─── إدارة أسماء الشركة البديلة (CompanyAlias) ──────────────────────────────
// منفصل عن companies.controller.js عمداً: الدوال listCompanyAliases/
// createCompanyAlias/deleteCompanyAlias هناك تتعامل فعلياً مع ItemMergeRule
// (اسم مضلّل تاريخياً)، فلتفادي التصادم واللبس أضفنا هذا الملف لـ CompanyAlias
// الحقيقي — الذي كان بالسكيما بلا أي CRUD أو واجهة إدارة قبل الآن.
import prisma from '../../lib/prisma.js';
import { normalizeItemKey } from '../../lib/itemResolver.js';

// ── List all alternate names saved for one company ─────────────────────────
export async function listCompanyNameAliases(req, res) {
  const companyId = parseInt(req.params.id);
  const rows = await prisma.companyAlias.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: rows });
}

// ── Create/update an alternate name manually (fromName → this company) ─────
export async function createCompanyNameAlias(req, res) {
  const companyId = parseInt(req.params.id);
  const { fromName } = req.body || {};
  if (!fromName?.trim()) return res.status(400).json({ error: 'الاسم البديل مطلوب' });

  const company = await prisma.scientificCompany.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, officeId: true },
  });
  if (!company) return res.status(404).json({ error: 'الشركة غير موجودة' });

  const fromKey = normalizeItemKey(fromName);
  if (!fromKey || normalizeItemKey(company.name) === fromKey)
    return res.status(400).json({ error: 'الاسم البديل غير صالح أو مطابق لاسم الشركة' });

  // فعل يدوي مقصود من مشرف ينظر مباشرة للنتيجة — upsert هنا مقبول (خلافاً
  // لسكربت الاستيراد الدفعي الذي يُمنع من الكتابة فوق تعارض بصمت).
  const alias = await prisma.companyAlias.upsert({
    where:  { officeId_fromKey: { officeId: company.officeId, fromKey } },
    update: { fromName: fromName.trim(), companyId: company.id },
    create: { officeId: company.officeId, fromKey, fromName: fromName.trim(), companyId: company.id },
  });
  res.status(201).json({ success: true, data: alias });
}

// ── Delete an alternate name ────────────────────────────────────────────────
export async function deleteCompanyNameAlias(req, res) {
  const companyId = parseInt(req.params.id);
  const aliasId = parseInt(req.params.aliasId);
  await prisma.companyAlias.deleteMany({ where: { id: aliasId, companyId } });
  res.json({ success: true });
}
