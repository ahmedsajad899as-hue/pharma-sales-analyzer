// «بدون الفارمسي» — طريقة العزل لكل شركة (السوبر أدمن وحده).
// null = «معلومات الزبون» (تسميات المسوقين في ملف المكتب)، 'yazen' = مطابقة صفوف اليزن في ميركاتو.
import prisma from '../../lib/prisma.js';
import { yazenMatchStatus, forceYazenMatch, GLOBAL_SCOPE } from '../../lib/yazenOfficeMatch.js';
import { PHARMACY_EXCLUSION_YAZEN, clearPharmacyOfficeIdsCache } from '../scientific-reps/scientific-reps.service.js';

/** PUT /api/sa/companies/:id/pharmacy-exclusion — { source: 'yazen' | null } */
export async function setPharmacyExclusion(req, res) {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صالح' });
  const source = req.body?.source === PHARMACY_EXCLUSION_YAZEN ? PHARMACY_EXCLUSION_YAZEN : null;
  try {
    const c = await prisma.scientificCompany.update({ where: { id }, data: { pharmacyExclusionSource: source }, select: { id: true, pharmacyExclusionSource: true } });
    clearPharmacyOfficeIdsCache();
    res.json({ success: true, data: c });
  } catch (e) {
    res.status(e.code === 'P2025' ? 404 : 500).json({ error: e.code === 'P2025' ? 'الشركة غير موجودة' : e.message });
  }
}

/** GET /api/sa/companies/yazen-match/status — آخر مطابقة (نطاق واحد شامل لكل الملفات). */
export async function getYazenMatchStatus(req, res) {
  try {
    const runs = await yazenMatchStatus();
    res.json({ success: true, data: runs.map(r => ({ ...r, label: r.scopeKey === GLOBAL_SCOPE ? 'كل الملفات' : r.scopeKey })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/** POST /api/sa/companies/yazen-match/rerun — { scopeKey } إعادة المطابقة فوراً. */
export async function rerunYazenMatch(req, res) {
  const scopeKey = String(req.body?.scopeKey ?? '');
  if (scopeKey !== GLOBAL_SCOPE) return res.status(400).json({ error: 'نطاق غير صالح' });
  try {
    const run = await forceYazenMatch(scopeKey);
    res.json({ success: true, data: run });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
