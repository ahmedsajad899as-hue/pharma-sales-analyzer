// ════════════════════════════════════════════════════════════════════════════
// externalRepNames.js — هل المندوب مربوط باسم في دوفايد / ميركاتو؟
// ────────────────────────────────────────────────────────────────────────────
// طلب 2026-11-27: علامة بجانب كل مندوب في صفحة الكولات (دوفايد) وفي المبيعات
// (ميركاتو)، وصفحة في السوبر أدمن تعرض الحالة وتسمح بالربط والتعديل.
//
// مصادر الأسماء:
//   • دوفايد  → جدول ExternalRepName (source='dofied')، يُملأ من عمود task-to في كل
//               ملف دوفايد يُقرأ. ودليل إضافي: زيارات محفوظة من دفعات مصدرها دوفايد.
//   • ميركاتو → أسماء «اسم المندوب» في صفوف ملفات ميركاتو نفسها (لا تخزين إضافي).
//
// قاعدة «مربوط» تطابق ما يفعله كل مسار فعلاً:
//   • ميركاتو: نسبة المبيعات (resolveSciRepSales) تقبل الاسم الكامل المطبَّع للمندوب
//     + مفاتيح SciRepNameLink فقط — فهذا هو الربط، لا أقل ولا أكثر.
//   • دوفايد: استيراد الزيارات يحسم تلقائياً بالاسم الكامل أو النواة («الاسم/ المنطقة»)
//     أو النواة بلا مسافات، ثم بروابط SciRepNameLink.
// الربط اليدوي يكتب في SciRepNameLink نفسه (نفس جدول نافذة مطابقة الأسماء) فيسري
// على استيراد الزيارات ونسبة مبيعات ميركاتو معاً.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeRepName, repCoreKey, repTightKey } from './repNameMatch.js';

export const DOFIED = 'dofied';
export const MERCATO = 'mercato';

let ctxCache = null; // { at, promise }
const CTX_TTL_MS = 3 * 60 * 1000;
export function invalidateExternalNames() { ctxCache = null; }

/** يسجّل أسماء مندوبين رآها مصدر خارجي. لا يرمي — فشل التسجيل لا يُسقط أي استيراد. */
export async function recordExternalRepNames(source, names) {
  const uniq = new Map();
  for (const n of names || []) {
    const name = String(n ?? '').trim();
    const key = normalizeRepName(name);
    if (key && !uniq.has(key)) uniq.set(key, name);
  }
  if (uniq.size === 0) return 0;
  const now = new Date();
  try {
    for (const [nameKey, name] of uniq) {
      await prisma.externalRepName.upsert({
        where: { source_nameKey: { source, nameKey } },
        update: { name, lastSeenAt: now, seenCount: { increment: 1 } },
        create: { source, nameKey, name, firstSeenAt: now, lastSeenAt: now },
      });
    }
    invalidateExternalNames();
  } catch (e) {
    console.error('[externalRepNames] record failed:', e?.message);
  }
  return uniq.size;
}

const pushTo = (map, key, v) => {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(v);
};

async function buildContext() {
  const [dofiedRows, mercatoFiles, dofiedBatches] = await Promise.all([
    prisma.externalRepName.findMany({ where: { source: DOFIED }, select: { name: true, nameKey: true, lastSeenAt: true, seenCount: true } }),
    prisma.uploadedFile.findMany({ where: { sourceSystem: MERCATO }, select: { id: true } }),
    prisma.visitImportBatch.findMany({ where: { source: DOFIED, isActive: true }, select: { id: true } }),
  ]);

  // دوفايد: فهارس بالمفتاح الكامل والنواة والنواة المرصوصة — نفس مستويات matchRepName
  const dofied = new Map(), dofiedByCore = new Map(), dofiedByTight = new Map();
  for (const r of dofiedRows) {
    const e = { name: r.name, key: r.nameKey, lastSeenAt: r.lastSeenAt, seenCount: r.seenCount };
    dofied.set(r.nameKey, e);
    pushTo(dofiedByCore, repCoreKey(r.name), e);
    pushTo(dofiedByTight, repTightKey(r.name), e);
  }

  // ميركاتو: أسماء «اسم المندوب» الفعلية في ملفاته وعدد صفوف كل اسم
  const mercato = new Map();
  if (mercatoFiles.length) {
    const groups = await prisma.sale.groupBy({
      by: ['representativeId'],
      where: { uploadedFileId: { in: mercatoFiles.map(f => f.id) }, isHidden: false },
      _count: { _all: true },
    });
    const medReps = groups.length
      ? await prisma.medicalRepresentative.findMany({ where: { id: { in: groups.map(g => g.representativeId) } }, select: { id: true, name: true } })
      : [];
    const countById = new Map(groups.map(g => [g.representativeId, g._count._all]));
    for (const m of medReps) {
      const key = normalizeRepName(m.name);
      if (!key) continue;
      const cur = mercato.get(key);
      const rows = countById.get(m.id) || 0;
      if (cur) cur.rows += rows;
      else mercato.set(key, { name: String(m.name).trim(), key, rows });
    }
  }

  // دليل من الزيارات: مندوب له زيارات محفوظة من دفعات سُحبت من دوفايد ⇒ اسمه في
  // دوفايد يُحسم إليه فعلاً، حتى قبل أن يمتلئ سجلّ الأسماء.
  const evidence = new Map(); // repId → { visits, lastVisit }
  if (dofiedBatches.length) {
    const ids = dofiedBatches.map(b => b.id);
    const q = { by: ['scientificRepId'], where: { visitImportBatchId: { in: ids }, isActive: true, scientificRepId: { not: null } }, _count: { _all: true }, _max: { visitDate: true } };
    const [dv, pv] = await Promise.all([prisma.doctorVisit.groupBy(q), prisma.pharmacyVisit.groupBy(q)]);
    for (const g of [...dv, ...pv]) {
      const cur = evidence.get(g.scientificRepId) || { visits: 0, lastVisit: null };
      cur.visits += g._count._all;
      const d = g._max.visitDate;
      if (d && (!cur.lastVisit || d > cur.lastVisit)) cur.lastVisit = d;
      evidence.set(g.scientificRepId, cur);
    }
  }
  return { dofied, dofiedByCore, dofiedByTight, mercato, evidence };
}

export async function loadExternalContext({ fresh = false } = {}) {
  if (!fresh && ctxCache && Date.now() - ctxCache.at < CTX_TTL_MS) return ctxCache.promise;
  const promise = buildContext();
  ctxCache = { at: Date.now(), promise };
  promise.catch(() => { if (ctxCache?.promise === promise) ctxCache = null; });
  return promise;
}

/**
 * حالة الربط لكل مندوب (ScientificRepresentative.id).
 * @returns {Promise<Map<number, {dofied:{linked,names,visits,lastVisit}, mercato:{linked,names}, other:{key,name}[]}>>}
 *   names: [{ name, key, via: 'exact'|'link', linkId? }]
 *   other: روابط محفوظة لاسم لم يرد في أي من المصدرين حالياً (للعرض والحذف فقط)
 */
export async function externalLinksForReps(repIds, ctxArg = null) {
  const ids = [...new Set((repIds || []).map(Number).filter(Number.isInteger))].filter(id => id > 0);
  const out = new Map();
  if (ids.length === 0) return out;
  const ctx = ctxArg || await loadExternalContext();
  const [reps, links] = await Promise.all([
    prisma.scientificRepresentative.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.sciRepNameLink.findMany({ where: { scientificRepId: { in: ids } }, select: { id: true, fromKey: true, fromName: true, scientificRepId: true } }),
  ]);
  const linksByRep = new Map();
  for (const l of links) pushTo(linksByRep, l.scientificRepId, l);

  for (const rep of reps) {
    const full = normalizeRepName(rep.name);
    const core = repCoreKey(rep.name);
    const tight = repTightKey(rep.name);

    const dNames = new Map();
    const addD = (e, via, linkId = null) => { if (!dNames.has(e.key)) dNames.set(e.key, { name: e.name, key: e.key, via, ...(linkId ? { linkId } : {}) }); };
    if (ctx.dofied.has(full)) addD(ctx.dofied.get(full), 'exact');
    for (const e of ctx.dofiedByCore.get(core) || []) addD(e, 'exact');
    for (const e of ctx.dofiedByTight.get(tight) || []) addD(e, 'exact');

    const mNames = new Map();
    if (ctx.mercato.has(full)) { const e = ctx.mercato.get(full); mNames.set(full, { name: e.name, key: full, via: 'exact', rows: e.rows }); }

    const other = [];
    for (const l of linksByRep.get(rep.id) || []) {
      let used = false;
      if (ctx.dofied.has(l.fromKey)) { used = true; if (!dNames.has(l.fromKey)) dNames.set(l.fromKey, { name: ctx.dofied.get(l.fromKey).name, key: l.fromKey, via: 'link', linkId: l.id }); }
      if (ctx.mercato.has(l.fromKey)) { used = true; if (!mNames.has(l.fromKey)) mNames.set(l.fromKey, { name: ctx.mercato.get(l.fromKey).name, key: l.fromKey, via: 'link', linkId: l.id, rows: ctx.mercato.get(l.fromKey).rows }); }
      if (!used && l.fromKey !== full) other.push({ key: l.fromKey, name: l.fromName, linkId: l.id });
    }

    const ev = ctx.evidence.get(rep.id) || null;
    out.set(rep.id, {
      dofied: { linked: dNames.size > 0 || !!ev, names: [...dNames.values()], visits: ev?.visits ?? 0, lastVisit: ev?.lastVisit ?? null },
      mercato: { linked: mNames.size > 0, names: [...mNames.values()] },
      other,
    });
  }
  return out;
}

/** ملخص المصادر: هل في السجلّ أسماء أصلاً؟ (بلا أسماء دوفايد لا معنى لعلامة «غير مربوط»). */
export function sourceSummary(ctx) {
  let lastDofied = null;
  for (const e of ctx.dofied.values()) if (!lastDofied || e.lastSeenAt > lastDofied) lastDofied = e.lastSeenAt;
  return {
    dofied: { names: ctx.dofied.size, lastSeenAt: lastDofied, evidenceReps: ctx.evidence.size },
    mercato: { names: ctx.mercato.size },
  };
}
