// ════════════════════════════════════════════════════════════════════════════
// yazenOfficeMatch.js — مطابقة صفوف «اليزن» في ميركاتو بصفوفها في ملف المكتب.
//
// طلب 2026-11-19: زر «بدون الفارمسي» في تقرير العلميين كان يعزل صفوف ملف المكتب المحسوبة
// للمسوقين بـ«معلومات الزبون». منذ صار مكتب المسوّق يُحسب من صفوف اليزن (officeSource=
// 'warehouse') لم يبقَ له صف في ملف المكتب، فصار الزر بلا أثر. هنا يُطابَق كل صف يزن باسم
// مسوّق بصفّه في ملف المكتب (الطلبية نفسها): الايتم + الكمية + الصيدلية + التاريخ، وطلبية
// اليزن تسبق ملف المكتب غالباً بيوم. شركة على 'yazen' (ScientificCompany.pharmacyExclusionSource)
// تعزل صفوف المكتب المطابقة.
//
// المطابقة ثقيلة نسبياً، فتُحسب في الخلفية بعد كل رفع/حذف وتُحفظ (YazenOfficeMatch)، والتقرير
// يقرأ الجاهز. بصمة النطاق (عدد الصفوف + أكبر id + الملفات + أسماء المسوقين) تقرّر إعادة الحساب.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeItemKey } from './itemResolver.js';
import { areSimilar } from './fuzzyMatch.js';
import { matchHelpers } from './manualDuplicateCheck.js';
import { CONDITION_VARIANT } from './saleFingerprint.js';
import { normalizeRepName } from './repNameMatch.js';
import { PHARMACY_KIND, OFFICE_WAREHOUSE_SQL, isOfficeWarehouseRow } from './pharmacyRep.js';

const DAY = 86400000;
// ملف المكتب يُخزَّن بمنتصف ليل بغداد (21:00 UTC اليوم السابق)، وميركاتو بوقت الساعة كما هو.
const OFFICE_TZ_SHIFT = 3 * 3600000;
/** فرق الأيام (يوم المكتب − يوم اليزن) بالأفضلية: اليوم التالي أولاً. */
export const GAP_PREFERENCE = [1, 0, 2, -1, 3];
/** كمية مختلفة (تجهيز جزئي): اليوم نفسه أو التالي فقط. */
const ANY_QTY_GAPS = [1, 0];

const parseRaw = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const isReturn = (s) => String(s.recordType ?? 'sale').trim().toLowerCase() === 'return';
const isConditionFile = (f) => String(f?.mergeGroup ?? '').endsWith(`|${CONDITION_VARIANT}`);

// ── الجزء الصافي (بلا قاعدة بيانات) — يُختبر في scripts/test-yazen-match.mjs ──

/** صف يزن (Sale من ميركاتو مع rawData) ← شكل المطابقة. */
export function prepareYazenRow(s, repId = null) {
  const raw = parseRaw(s.rawData);
  return {
    id: s.id, repId, ret: isReturn(s),
    itemId: s.itemId ?? null,
    keys: new Set([normalizeItemKey(s.item?.name ?? ''), raw['اسم المادة بالمكتب'] ? normalizeItemKey(raw['اسم المادة بالمكتب']) : null].filter(Boolean)),
    qty: Math.abs(Number(s.quantity) || 0),
    bonus: Math.abs(Number(raw.bonus ?? raw['كمية البونص']) || 0),
    pharmacy: matchHelpers.pharmKey(raw.pharmacy || s.customer?.name || raw['اسم الشركة'] || ''),
    area: matchHelpers.areaKey(s.area?.name),
    day: matchHelpers.dayOf(s.saleDate),
  };
}

/** صف ملف المكتب (حقول خفيفة، بلا rawData) ← شكل المطابقة. */
export function prepareOfficeRow(s) {
  const t = s.saleDate ? new Date(new Date(s.saleDate).getTime() + OFFICE_TZ_SHIFT) : null;
  return {
    id: s.id, ret: isReturn(s),
    itemId: s.itemId ?? null,
    keys: new Set([normalizeItemKey(s.item?.name ?? '')].filter(Boolean)),
    qty: Math.abs(Number(s.quantity) || 0),
    pharmacy: matchHelpers.pharmKey(s.customer?.name ?? ''),
    area: matchHelpers.areaKey(s.area?.name),
    day: matchHelpers.dayOf(t),
  };
}

/** ميركاتو قد يعدّ البونص ضمن الكمية أو خارجها. */
const sameQty = (y, o) => Math.abs(y.qty - o.qty) < 0.001
  || (y.bonus > 0 && (Math.abs(y.qty + y.bonus - o.qty) < 0.001 || Math.abs(y.qty - y.bonus - o.qty) < 0.001));

function sameItem(y, o) {
  if (y.itemId && o.itemId && y.itemId === o.itemId) return true;
  for (const k of o.keys) if (y.keys.has(k)) return true;
  for (const a of y.keys) for (const b of o.keys) if (areSimilar(a, b)) return true;
  return false;
}

function samePharmacy(y, o) {
  if (matchHelpers.namesMatch(y.pharmacy, o.pharmacy) !== true) return false;
  // منطقة مختلفة صراحةً = صيدلية أخرى بالاسم نفسه. الطرف الفارغ لا يمنع.
  return matchHelpers.namesMatch(y.area, o.area, 0.85) !== false;
}

/**
 * مطابقة واحد لواحد. الدورة الخارجية على فرق الأيام بالأفضلية، فكل مطابقات «اليوم التالي»
 * تُحسم قبل «اليوم نفسه» — لا يسرق صفٌّ أبعد مطابقةَ صف أقرب.
 * @param {Array} yazen مُحضَّرة بـ prepareYazenRow
 * @param {Array} office مُحضَّرة بـ prepareOfficeRow
 * @returns {Array<{officeSaleId:number, mercatoSaleId:number, marketerRepId:number|null, gapDays:number}>}
 */
export function matchYazenToOffice(yazen, office) {
  const byDay = new Map();
  for (const o of office) {
    if (o.day == null) continue;
    if (!byDay.has(o.day)) byDay.set(o.day, []);
    byDay.get(o.day).push(o);
  }
  const usedOffice = new Set();
  const doneYazen = new Set();
  const out = [];
  const pass = (gaps, qtyOk) => {
    for (const gap of gaps) {
      for (const y of yazen) {
        if (doneYazen.has(y) || y.day == null) continue;
        const list = byDay.get(y.day + gap * DAY);
        if (!list) continue;
        for (const o of list) {
          if (usedOffice.has(o) || o.ret !== y.ret || !qtyOk(y, o)) continue;
          if (!samePharmacy(y, o) || !sameItem(y, o)) continue;
          usedOffice.add(o); doneYazen.add(y);
          out.push({ officeSaleId: o.id, mercatoSaleId: y.id, marketerRepId: y.repId, gapDays: gap });
          break;
        }
      }
    }
  };
  pass(GAP_PREFERENCE, sameQty);
  pass(ANY_QTY_GAPS, () => true);
  return out;
}

/**
 * تشخيص: لكل صف يزن لم يُطابَق — أبعد مرحلة بلغها أقرب مرشح في نافذة الأيام.
 * المراحل: noDay (لا صف مكتب في تلك الأيام) → type → item → pharmacy → qty → used.
 */
export function explainUnmatched(yazen, office, matches) {
  const done = new Set(matches.map(m => m.mercatoSaleId));
  const usedOffice = new Set(matches.map(m => m.officeSaleId));
  const byDay = new Map();
  for (const o of office) { if (o.day == null) continue; if (!byDay.has(o.day)) byDay.set(o.day, []); byDay.get(o.day).push(o); }
  const STAGES = ['noDay', 'type', 'item', 'pharmacy', 'qty', 'used'];
  const counts = Object.fromEntries(STAGES.map(s => [s, 0]));
  const samples = [];
  for (const y of yazen) {
    if (done.has(y.id)) continue;
    let best = 0, cand = null;
    for (const gap of GAP_PREFERENCE) {
      for (const o of byDay.get(y.day + gap * DAY) ?? []) {
        let st = 1;
        if (o.ret === y.ret) { st = 2; if (sameItem(y, o)) { st = 3; if (samePharmacy(y, o)) { st = 4; if (sameQty(y, o)) st = 5; } } }
        if (st > best) { best = st; cand = o; }
      }
    }
    counts[STAGES[best]]++;
    if (samples.length < 6 && best >= 2) {
      samples.push({ stage: STAGES[best], yazen: { day: y.day && new Date(y.day).toISOString().slice(0, 10), pharmacy: y.pharmacy, area: y.area, keys: [...y.keys], qty: y.qty },
        office: cand && { day: cand.day && new Date(cand.day).toISOString().slice(0, 10), pharmacy: cand.pharmacy, area: cand.area, keys: [...cand.keys], qty: cand.qty, used: usedOffice.has(cand.id) } });
    }
  }
  return { counts, samples };
}

// ── النطاق: كل ملفات المبيعات (مطابقة واحدة شاملة) ─────────────────────────────
// كان النطاق مكتب صاحب الملف، لكن ملف المكتب الشهري قد يرفعه حساب خارج مكتب من رفع ميركاتو
// (أول تشغيل على الإنتاج: 0/483 لأن ملف المكتب الفعلي في نطاق آخر). المطابقة تتطلب الصيدلية
// والايتم والكمية والتاريخ معاً، فلا خطر يُذكر من خلط ملفات مكاتب أخرى.
export const GLOBAL_SCOPE = 'all';

/** نطاقات الملفات المعطاة (نطاق واحد شامل). */
export async function scopeKeysForFiles(fileIds) {
  return (fileIds || []).length ? [GLOBAL_SCOPE] : [];
}

async function loadScopeFiles(scopeKey) {
  return prisma.uploadedFile.findMany({
    where: { fileType: { in: ['sales', 'returns'] } },
    select: { id: true, sourceSystem: true, mergeGroup: true },
  });
}

/** أسماء المسوقين المطبَّعة (الاسم + روابط أسماء المندوبين) → معرّف المسوّق. */
async function loadMarketerNames() {
  const users = await prisma.user.findMany({
    where: { isActive: true, linkedRepId: { not: null }, linkedRep: { is: { repKind: PHARMACY_KIND } } },
    select: { linkedRepId: true, linkedRep: { select: { name: true } } },
  });
  const repIds = [...new Set(users.map(u => u.linkedRepId))];
  const links = repIds.length
    ? await prisma.sciRepNameLink.findMany({ where: { scientificRepId: { in: repIds } }, select: { fromKey: true, scientificRepId: true } })
    : [];
  const byName = new Map();
  for (const u of users) { const k = normalizeRepName(u.linkedRep?.name ?? ''); if (k && !byName.has(k)) byName.set(k, u.linkedRepId); }
  for (const l of links) if (l.fromKey && !byName.has(l.fromKey)) byName.set(l.fromKey, l.scientificRepId);
  return byName;
}

async function scopeFingerprint(files, names) {
  const ids = files.map(f => f.id).sort((a, b) => a - b);
  if (!ids.length) return `v${MATCH_VERSION}|empty`;
  const agg = await prisma.sale.aggregate({ where: { uploadedFileId: { in: ids }, isHidden: false }, _count: { _all: true }, _max: { id: true } });
  const nameSig = [...names.entries()].map(([k, v]) => `${k}=${v}`).sort().join(',');
  let h = 0;
  for (let i = 0; i < nameSig.length; i++) h = (h * 31 + nameSig.charCodeAt(i)) | 0;
  return `v${MATCH_VERSION}|${ids.join(',')}|${agg._count._all}|${agg._max.id ?? 0}|${h}`;
}

// يُرفع مع أي تغيير في قواعد المطابقة، فيُعاد حساب كل نطاق عند الإقلاع.
const MATCH_VERSION = 3;

const yieldLoop = () => new Promise(r => setImmediate(r));

async function computeScope(scopeKey, { force = false } = {}) {
  const t0 = Date.now();
  const [files, names] = await Promise.all([loadScopeFiles(scopeKey), loadMarketerNames()]);
  const fp = await scopeFingerprint(files, names);
  const prev = await prisma.yazenMatchRun.findUnique({ where: { scopeKey } });
  if (!force && prev?.fingerprint === fp && prev.status === 'idle') return prev;

  await prisma.yazenMatchRun.upsert({
    where: { scopeKey },
    create: { scopeKey, status: 'running', startedAt: new Date() },
    update: { status: 'running', startedAt: new Date(), error: null },
  });
  try {
    const mercatoIds = files.filter(f => f.sourceSystem === 'mercato' && !isConditionFile(f)).map(f => f.id);
    const officeIds = files.filter(f => f.sourceSystem !== 'mercato').map(f => f.id);

    // صفوف اليزن بـ SQL أولاً: rawData يُحمَّل لها وحدها لا لكل ميركاتو.
    const yazenIdRows = mercatoIds.length
      ? await prisma.$queryRawUnsafe(
          `SELECT id FROM sales WHERE "uploadedFileId" IN (${mercatoIds.join(',')}) AND "isHidden" = false AND ${OFFICE_WAREHOUSE_SQL}`)
      : [];
    const yazenSales = yazenIdRows.length
      ? await prisma.sale.findMany({
          where: { id: { in: yazenIdRows.map(r => Number(r.id)) } },
          select: {
            id: true, itemId: true, quantity: true, recordType: true, saleDate: true, rawData: true,
            item: { select: { name: true } }, customer: { select: { name: true } }, area: { select: { name: true } },
            representative: { select: { name: true } },
          },
        })
      : [];
    const yazen = [];
    for (const s of yazenSales) {
      if (!isOfficeWarehouseRow(s.rawData)) continue;
      const repId = names.get(normalizeRepName(s.representative?.name ?? ''));
      if (repId == null) continue; // يزن مندوب علمي: يبقى مبيعه هو، لا فارمسي
      yazen.push(prepareYazenRow(s, repId));
    }

    // كل ملف مكتب يُطابَق وحده: نسخ بيانات المكتب نفسها في ملفات حسابات مختلفة تُعزل كلها،
    // وصف المكتب لا يُستعمل مرتين داخل ملفه.
    let matches = [];
    const days = yazen.map(y => y.day).filter(d => d != null);
    const matchedYazen = new Set();
    if (days.length && officeIds.length) {
      // نطاق التواريخ فقط (لا ايتمات): الايتم قد يختلف معرّفه بين ملفَي النظامين.
      const from = new Date(Math.min(...days) - 2 * DAY);
      const to = new Date(Math.max(...days) + 5 * DAY);
      const fmt = (d) => new Date(d).toISOString().slice(0, 10);
      let biggest = null;
      for (const fileId of officeIds) {
        const office = [];
        const BATCH = 5000;
        let cursor = 0;
        for (;;) {
          const rows = await prisma.sale.findMany({
            where: { uploadedFileId: fileId, isHidden: false, saleDate: { gte: from, lte: to }, id: { gt: cursor } },
            select: {
              id: true, itemId: true, quantity: true, recordType: true, saleDate: true,
              item: { select: { name: true } }, customer: { select: { name: true } }, area: { select: { name: true } },
            },
            orderBy: { id: 'asc' }, take: BATCH,
          });
          for (const r of rows) office.push(prepareOfficeRow(r));
          if (rows.length < BATCH) break;
          cursor = rows[rows.length - 1].id;
          await yieldLoop();
        }
        if (!office.length) continue;
        await yieldLoop();
        const found = matchYazenToOffice(yazen, office);
        for (const m of found) { matches.push(m); matchedYazen.add(m.mercatoSaleId); }
        console.log(`[yazen-match] file ${fileId}: ${office.length} office rows in window, matched ${found.length}/${yazen.length}`);
        if (!biggest || office.length > biggest.office.length) biggest = { fileId, office, found };
      }
      console.log(`[yazen-match] yazen ${fmt(Math.min(...days))}..${fmt(Math.max(...days))}, office files ${officeIds.length}`);
      if (biggest && biggest.found.length < yazen.length) {
        const why = explainUnmatched(yazen, biggest.office, biggest.found);
        console.log(`[yazen-match] file ${biggest.fileId} unmatched by stage ${JSON.stringify(why.counts)}`);
        for (const smp of why.samples) console.log(`[yazen-match] sample ${JSON.stringify(smp)}`);
      }
    } else {
      console.log(`[yazen-match] ${scopeKey} skipped: yazen days ${days.length}, office files ${officeIds.length}`);
    }

    await prisma.$transaction(async (tx) => {
      // يشمل صفوف النطاقات القديمة (office:N) من قبل النطاق الشامل.
      await tx.yazenOfficeMatch.deleteMany({});
      for (let i = 0; i < matches.length; i += 1000) {
        await tx.yazenOfficeMatch.createMany({ data: matches.slice(i, i + 1000).map(m => ({ ...m, scopeKey })), skipDuplicates: true });
      }
      await tx.yazenMatchRun.deleteMany({ where: { scopeKey: { not: scopeKey } } });
    }, { timeout: 60_000 });
    const ms = Date.now() - t0;
    const run = await prisma.yazenMatchRun.update({
      where: { scopeKey },
      data: { status: 'idle', fingerprint: fp, matched: matchedYazen.size, yazenRows: yazen.length, ms, finishedAt: new Date() },
    });
    console.log(`[yazen-match] ${scopeKey} matched ${matchedYazen.size}/${yazen.length} yazen rows (${matches.length} office rows) in ${ms}ms`);
    return run;
  } catch (e) {
    console.error(`[yazen-match] ${scopeKey} failed:`, e.message);
    await prisma.yazenMatchRun.update({ where: { scopeKey }, data: { status: 'failed', error: String(e.message).slice(0, 500), finishedAt: new Date() } }).catch(() => {});
    throw e;
  }
}

// ── الجدولة: نطاق واحد يعمل في كل لحظة (ذاكرة السيرفر هي القيد) ────────────────

let chain = Promise.resolve();
const running = new Map(); // scopeKey → promise
const timers = new Map();
const lastChecked = new Map(); // scopeKey → آخر فحص بصمة عند القراءة

function runScope(scopeKey, opts) {
  if (running.has(scopeKey)) return running.get(scopeKey);
  const p = chain.then(() => computeScope(scopeKey, opts));
  chain = p.catch(() => {});
  running.set(scopeKey, p);
  p.catch(() => {}).finally(() => running.delete(scopeKey));
  return p;
}

/** يجدول إعادة المطابقة بعد مهلة قصيرة (رفعات متتالية = تشغيل واحد). */
export function scheduleYazenMatch(scopeKey, delayMs = 20_000) {
  if (!scopeKey) return;
  clearTimeout(timers.get(scopeKey));
  timers.set(scopeKey, setTimeout(() => { timers.delete(scopeKey); runScope(scopeKey).catch(() => {}); }, delayMs));
}

/** بعد رفع/حذف في هذه الملفات. لا يرمي أبداً. */
export async function scheduleYazenMatchForFiles(fileIds) {
  try { for (const k of await scopeKeysForFiles(fileIds)) scheduleYazenMatch(k); } catch (e) { console.error('[yazen-match] schedule', e.message); }
}

/** بعد رفع ملف لمستخدم (الملف الجديد قد لا يُعرف معرّفه هنا). */
export function scheduleYazenMatchForUser() {
  scheduleYazenMatch(GLOBAL_SCOPE);
}

/**
 * قبل قراءة المطابقات: نطاق لم يُحسب قطّ يُحسب الآن (مرة واحدة)، ونطاق بصمته قديمة يُجدوَل في
 * الخلفية ويُقرأ آخر ناتج محفوظ — العرض لا ينتظر.
 */
export async function ensureYazenMatches(fileIds) {
  const keys = await scopeKeysForFiles(fileIds);
  const runs = await prisma.yazenMatchRun.findMany({ where: { scopeKey: { in: keys } } });
  const byKey = new Map(runs.map(r => [r.scopeKey, r]));
  for (const k of keys) {
    const r = byKey.get(k);
    if (!r?.finishedAt) { await runScope(k).catch(() => {}); continue; }
    if (running.has(k) || timers.has(k)) continue;
    if (Date.now() - (lastChecked.get(k) ?? 0) < 30_000) continue;
    lastChecked.set(k, Date.now());
    const [files, names] = await Promise.all([loadScopeFiles(k), loadMarketerNames()]);
    if (await scopeFingerprint(files, names) !== r.fingerprint) scheduleYazenMatch(k, 0);
  }
}

/** معرّفات صفوف المكتب المطابقة ليزن، من بين المعطاة. */
export async function matchedOfficeSaleIds(saleIds) {
  const ids = [...new Set(saleIds)].filter(Number.isInteger);
  const out = new Set();
  for (let i = 0; i < ids.length; i += 20_000) {
    const rows = await prisma.yazenOfficeMatch.findMany({ where: { officeSaleId: { in: ids.slice(i, i + 20_000) } }, select: { officeSaleId: true } });
    for (const r of rows) out.add(r.officeSaleId);
  }
  return out;
}

/** حالة كل نطاق — لصفحة السوبر أدمن. */
export async function yazenMatchStatus() {
  const runs = await prisma.yazenMatchRun.findMany({ orderBy: { scopeKey: 'asc' } });
  return runs.map(r => ({ ...r, busy: running.has(r.scopeKey) || timers.has(r.scopeKey) }));
}

/** عند الإقلاع: يتخطى الحساب إن لم تتغيّر البصمة. */
export function startYazenMatchOnBoot(delayMs = 60_000) {
  setTimeout(() => { runScope(GLOBAL_SCOPE).catch(() => {}); }, delayMs).unref?.();
}

/** إعادة الحساب فوراً (زر السوبر أدمن). */
export function forceYazenMatch(scopeKey) {
  return runScope(scopeKey, { force: true });
}
