// ════════════════════════════════════════════════════════════════════════════
// conditionNameMatch.js — مطابقة أسماء ايتمات/شركات ملف «لكوديشن المحافظات» مع
// ايتمات وشركات النظام قبل الحفظ (WarehouseGapImportModal → «مطابقة الأسماء»).
//
// لماذا كتالوج المكتب كله لا كتالوج الرافع: ملف مسوقي المحافظات يضم ايتمات كل
// الشركات، ومقارنته بمبيع المحافظة تحتسب الايتم فقط إن كان **ايتم كتالوج مُسنَداً
// لمدير شركة** (loadOfficeTeams في reports.routes.js) — ايتم بقي باسمه الخام
// يُنشأ مؤقتاً ويسقط من المقارنة صامتاً. لذلك يُعاد لكل ايتم مطابق «التيم» الذي
// سيُحتسب له، ليرى المستخدم مسبقاً ما سيدخل المقارنة وما لن يدخل.
//
// سلّم المطابقة نفسه في طلبيات البوت (orders.service.js): المحرّك
// resolveItemNameSync (تام ← قاعدة توحيد محفوظة ← ضبابي وحيد) ثم بديل «العلامة +
// الجرعة» (brandDoseFallback: «DEVIT-3 5.000 IU» ← «DEVIT 3 5000IU»).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { loadCompanyContext, resolveItemNameSync, normalizeItemKey } from './itemResolver.js';
import { similarity } from './fuzzyMatch.js';
import { loadItemOwnerManagers } from './itemOwnerManager.js';
import { brandDoseFallback } from '../modules/orders/orders.service.js';

const sure = r => !!r?.canonicalItem && (r.confidence === 'alias' || r.confidence === 'exact' || r.confidence === 'high');
// «OselTurk» / «Osel Turk» / «OSEL-TURK» مفتاح واحد.
const compact = s => normalizeItemKey(s).replace(/[^a-z0-9؀-ۿ]+/g, '');
const uniq = list => [...new Set(list.map(s => String(s ?? '').trim()).filter(Boolean))];

/**
 * @param {{id:number}} user
 * @param {{item?:string, company?:string}[]} pairs  أزواج (ايتم، شركة) المتمايزة من صفوف الملف
 * @returns {Promise<{
 *   catalog: {id:number, name:string, company:string|null, team:string|null}[],
 *   companyList: string[],
 *   items: {raw:string, status:'exact'|'auto'|'ask'|'none', match:object|null, suggestions:object[]}[],
 *   companies: {raw:string, status:'exact'|'auto'|'ask'|'none', match:string|null, via:'name'|'items'|null, suggestions:string[]}[],
 * }>}
 */
export async function matchConditionNames(user, pairs = []) {
  const list = Array.isArray(pairs) ? pairs : [];
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { officeId: true } });
  const officeId = me?.officeId ?? null;

  let sci = officeId != null
    ? await prisma.scientificCompany.findMany({ where: { officeId }, select: { id: true, name: true } })
    : [];
  if (!sci.length) {
    const ua = await prisma.userCompanyAssignment.findMany({ where: { userId: user.id }, select: { company: { select: { id: true, name: true } } } });
    sci = ua.map(a => a.company).filter(Boolean);
  }
  const ctx = await loadCompanyContext(sci.map(s => s.id));
  const owners = await loadItemOwnerManagers(officeId).catch(() => new Map());
  const sciName = new Map(sci.map(s => [s.id, s.name]));

  const catalog = ctx.catalog
    .map(c => ({ id: c.id, name: c.name, company: sciName.get(c.scientificCompanyId) ?? null, team: owners.get(c.id)?.companyName ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const byId = new Map(catalog.map(c => [c.id, c]));

  // ── الايتمات ──
  const items = [];
  const itemSciIds = new Map(); // الاسم الخام ← الشركة العلمية للايتم المطابق
  for (const raw of uniq(list.map(p => p?.item))) {
    let r = ctx.catalog.length ? resolveItemNameSync(raw, ctx) : { canonicalItem: null, confidence: 'none', suggestions: [] };
    const fb = sure(r) || !ctx.catalog.length ? null : brandDoseFallback(raw, ctx.catalog);
    if (sure(fb)) r = fb;
    if (sure(r) && byId.has(r.canonicalItem.id)) {
      const match = byId.get(r.canonicalItem.id);
      items.push({ raw, status: r.confidence === 'high' ? 'auto' : 'exact', match, suggestions: [] });
      itemSciIds.set(raw, ctx.catalogById.get(match.id)?.scientificCompanyId ?? null);
      continue;
    }
    // ملتبس: مرشّحو المحرّك ثم ما طابق الجرعة في عائلة العلامة ثم العائلة كلها.
    const seen = new Set();
    const suggestions = [];
    for (const c of [...(r.suggestions || []), ...(fb?.candidates || []), ...(fb?.family || [])]) {
      if (!c || seen.has(c.id) || !byId.has(c.id)) continue;
      seen.add(c.id);
      suggestions.push(byId.get(c.id));
      if (suggestions.length >= 6) break;
    }
    items.push({ raw, status: suggestions.length ? 'ask' : 'none', match: null, suggestions });
  }

  // ── الشركات: بالاسم ثم بشركة ايتماتها المطابقة ──
  const companies = [];
  for (const raw of uniq(list.map(p => p?.company))) {
    const key = compact(raw);
    const exact = sci.find(s => compact(s.name) === key);
    if (exact) { companies.push({ raw, status: 'exact', match: exact.name, via: 'name', suggestions: [] }); continue; }
    const cands = sci
      .map(s => {
        const k = compact(s.name);
        const contains = key.length >= 3 && k.length >= 3 && (k.includes(key) || key.includes(k));
        return { s, sim: contains ? Math.max(0.8, similarity(key, k)) : similarity(key, k) };
      })
      .filter(x => x.sim >= 0.75)
      .sort((a, b) => b.sim - a.sim);
    // شركة كل ايتمات هذه العلامة المطابقة — إن اتّفقت على شركة واحدة فهي الدليل الأقوى.
    const viaIds = new Set(list.filter(p => String(p?.company ?? '').trim() === raw).map(p => itemSciIds.get(String(p?.item ?? '').trim())).filter(id => id != null));
    const viaName = viaIds.size === 1 ? sciName.get([...viaIds][0]) ?? null : null;
    const suggestions = uniq([...cands.map(c => c.s.name), ...(viaName ? [viaName] : [])]).slice(0, 5);
    if (cands.length === 1 && (!viaName || viaName === cands[0].s.name)) {
      companies.push({ raw, status: 'auto', match: cands[0].s.name, via: 'name', suggestions });
    } else if (viaName && (cands.length === 0 || cands.some(c => c.s.name === viaName))) {
      companies.push({ raw, status: 'auto', match: viaName, via: 'items', suggestions });
    } else {
      companies.push({ raw, status: suggestions.length ? 'ask' : 'none', match: null, via: null, suggestions });
    }
  }

  const companyList = sci.map(s => s.name).sort((a, b) => a.localeCompare(b));
  return { catalog, companyList, items, companies };
}
