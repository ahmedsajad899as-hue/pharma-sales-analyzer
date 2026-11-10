// ════════════════════════════════════════════════════════════════════════════
// provinceVisitSurvey.js — سيرفي المحافظات يُبنى من الزيارات المرفوعة نفسها.
// ────────────────────────────────────────────────────────────────────────────
// لا يوجد سيرفي جاهز لأطباء وصيدليات المحافظات. فزيارة مندوب/قائد/مسوق محافظة لا
// تُطابَق بأسماء التطبيق ولا تُسأل عنها: اسم الطبيب/الصيدلية يُسجَّل في سيرفي
// منطقته مرة واحدة، وكل زيارة لاحقة بالاسم نفسه — من أي مندوب — تُضاف تحته.
//
// قرارات مقصودة:
//   • المنطقة تُحسم داخل محافظة الصف وحدها. مسار بغداد يطابق كل الكتالوج، و«الحسينية»
//     حيّ في بغداد وناحية في كربلاء. ولأن السيرفي مربوط بالمناطق بالاسم المطبَّع (لا
//     FK — راجع getScopedSurveyDoctors)، فاسم يملكه حيّ بمحافظة أخرى يُنشأ بلاحقة
//     المحافظة («الحسينية - كربلاء») وإلا اختلط أطباء المحافظتين.
//   • منع التكرار لا يوقف الاستيراد أبداً: تطابق واثق يُربط، وما عداه سجل جديد.
//     أقوى الخطأين ضرراً هو دمج طبيبين مختلفين، فالتشابه الإملائي محصور بالمنطقة
//     نفسها ويُسجَّل في طابور مراجعة السوبر أدمن (DoctorNameLink).
//   • الصفوف تُجهَّز هنا تسلسلياً ثم تمرّ بمسار الحفظ العادي (doctorId/areaId جاهزان)،
//     فلا مسار ثانٍ لإنشاء الزيارات يتباعد مع الوقت عن الأول.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeAreaName } from './itemResolver.js';
import { invalidateAreaSnapshot } from './areaResolver.js';
import { BAGHDAD_PROVINCE } from './pharmacyRep.js';
import { buildProvinceLookup, matchProvinceName } from './provinces.js';
import { findOrCreateProvinceCenter, provinceNameKeys } from './provinceNameCollision.js';
import { provinceIdsByMember } from './provinceScope.js';
import {
  createSurveyDoctor, cleanDoctorName, doctorLinkKey, doctorMatchScore,
  buildDoctorNameIndex, loadSurveyDoctorAliases,
} from './surveyDoctors.js';
import {
  createSurveyPharmacy, pharmacyDedupKey, pharmacyMatchScore,
  normalizePharmacyStoredName, loadSurveyPharmacyAliases,
} from './surveyPharmacies.js';
import { normalizeRepName, nameTokens } from './repNameMatch.js';

const PROVINCE_SURVEY_NAME = 'سيرفي المحافظات';
// يُعرَّف السيرفي بوصفه لا باسمه — السوبر أدمن قد يعيد تسميته فلا يُنشأ ثانٍ.
const PROVINCE_SURVEY_DESC = 'يُبنى تلقائياً من زيارات مندوبي المحافظات المرفوعة';

// نفس عتبة الربط التلقائي في commitDoctorRows (تشمل نقاط تطابق المنطقة).
const DOCTOR_FUZZY_MIN = 0.92;
// pharmacyMatchScore يضيف 0.12 لتطابق المنطقة ⇒ تشابه الاسم نفسه ≥ 0.85
const PHARMACY_FUZZY_MIN = 0.97;

// ملفات CRM تكتب المدينة بالإنجليزية (client-city = karbala)
const CITY_EN = {
  baghdad: 'بغداد', karbala: 'كربلاء', kerbala: 'كربلاء', najaf: 'النجف', basra: 'البصرة', basrah: 'البصرة',
  mosul: 'نينوى', nineveh: 'نينوى', ninawa: 'نينوى', erbil: 'أربيل', arbil: 'أربيل', hawler: 'أربيل',
  sulaymaniyah: 'السليمانية', sulaimani: 'السليمانية', slemani: 'السليمانية', sulaymaniya: 'السليمانية',
  duhok: 'دهوك', dohuk: 'دهوك', kirkuk: 'كركوك', diyala: 'ديالى', baqubah: 'ديالى', baquba: 'ديالى',
  anbar: 'الأنبار', ramadi: 'الأنبار', fallujah: 'الأنبار', babil: 'بابل', babylon: 'بابل', hilla: 'بابل', hillah: 'بابل',
  wasit: 'واسط', wassit: 'واسط', kut: 'واسط', salahaddin: 'صلاح الدين', salahuddin: 'صلاح الدين', tikrit: 'صلاح الدين', samarra: 'صلاح الدين',
  qadisiyah: 'القادسية', qadisiya: 'القادسية', diwaniyah: 'القادسية', diwaniya: 'القادسية',
  maysan: 'ميسان', missan: 'ميسان', amarah: 'ميسان', amara: 'ميسان',
  dhiqar: 'ذي قار', thiqar: 'ذي قار', nasiriyah: 'ذي قار', nasiriya: 'ذي قار',
  muthanna: 'المثنى', samawah: 'المثنى', samawa: 'المثنى',
};

/**
 * من هم مندوبو المحافظات (بمعرّف المندوب العلمي الذي تحمله الصفوف) + محافظة نصّ.
 * معرّف المندوب بنفس أولوية resolveRepId: linkedRepId ثم سجلّه هو.
 */
export async function loadProvinceVisitContext() {
  const members = await provinceIdsByMember();
  const provinces = await prisma.province.findMany({ select: { id: true, name: true, aliases: true } });
  const lookup = buildProvinceLookup(provinces);
  const byName = new Map(provinces.map(p => [p.name, p]));

  const repIndex = new Map(); // repId → { userId, provinceIds:Set }
  const ids = [...members.keys()];
  if (ids.length) {
    const [users, ownReps] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, linkedRepId: true } }),
      prisma.scientificRepresentative.findMany({ where: { userId: { in: ids } }, select: { id: true, userId: true } }),
    ]);
    const ownByUser = new Map();
    for (const r of ownReps) if (!ownByUser.has(r.userId)) ownByUser.set(r.userId, r.id);
    for (const u of users) {
      const repId = u.linkedRepId ?? ownByUser.get(u.id) ?? null;
      if (repId) repIndex.set(repId, { userId: u.id, provinceIds: members.get(u.id) });
    }
  }

  const provinceOfText = (text) => {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const en = CITY_EN[raw.toLowerCase().replace(/[^a-z]/g, '')];
    return en ? (byName.get(en) ?? null) : matchProvinceName(raw, lookup);
  };

  return { repIndex, provinces, provinceOfText };
}

/** الزبون في بغداد بنصّ الملف نفسه — فلا يدخل سيرفي المحافظات ولو كان مندوبه منها. */
export function isBaghdadClient(row, ctx) {
  return ctx.provinceOfText(row?.clientCity)?.name === BAGHDAD_PROVINCE;
}

export function isProvinceVisitRow(row, ctx) {
  return !!row?.repId && ctx.repIndex.has(row.repId) && !isBaghdadClient(row, ctx);
}

/**
 * وقت الاستخراج: يُعلَّم الصف ويرجع لعنوان الملف الخام بدل ما حسمته مطابقة الكتالوج
 * العامة (التي قد تكون حيّاً ببغداد بنفس الاسم). الحسم الفعلي عند الحفظ.
 */
export function markProvinceRows(rows, ctx) {
  for (const r of rows) {
    r.baghdadClient = isBaghdadClient(r, ctx);
    if (isProvinceVisitRow(r, ctx)) {
      r.areaName = r.rawAreaText ?? r.areaName;
      r.areaId = null;
    }
  }
  return rows;
}

async function getProvinceSurveyId() {
  const found = await prisma.masterSurvey.findFirst({
    where: { description: PROVINCE_SURVEY_DESC },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  if (found) return found.id;
  const created = await prisma.masterSurvey.create({
    data: { name: PROVINCE_SURVEY_NAME, description: PROVINCE_SURVEY_DESC, surveyType: 'general', isActive: true },
    select: { id: true },
  });
  return created.id;
}

// ── كتالوج المناطق مقسوماً على المحافظات ─────────────────────────────────────
async function buildAreaCatalog(ctx) {
  const [areas, aliases] = await Promise.all([
    prisma.area.findMany({ select: { id: true, name: true, provinceId: true, needsReview: true }, orderBy: { id: 'asc' } }),
    prisma.areaAlias.findMany({ select: { fromKey: true, areaId: true } }),
  ]);
  const provinceById = new Map(ctx.provinces.map(p => [p.id, p]));
  const byId = new Map(areas.map(a => [a.id, a]));
  const anyByKey = new Map();    // المفتاح المطبَّع (اسم أو alias) → أول منطقة تحمله
  const perProvince = new Map(); // provinceId → Map(مفتاح → منطقة)
  const stats = { newAreas: 0 };

  const provinceMap = (id) => {
    if (!perProvince.has(id)) perProvince.set(id, new Map());
    return perProvince.get(id);
  };
  // منطقة بلاحقة محافظتها («الحسينية - كربلاء») تُعرف أيضاً باسمها المجرّد داخل المحافظة
  const indexInProvince = (key, area) => {
    if (area.provinceId == null) return;
    const map = provinceMap(area.provinceId);
    if (!map.has(key)) map.set(key, area);
    const p = provinceById.get(area.provinceId);
    if (!p) return;
    for (const pk of provinceNameKeys(p)) {
      if (key !== pk && key.endsWith(` ${pk}`)) {
        const bare = key.slice(0, -pk.length - 1).trim();
        if (bare && !map.has(bare)) map.set(bare, area);
      }
    }
  };
  const indexArea = (key, area) => {
    if (!key) return;
    if (!anyByKey.has(key)) anyByKey.set(key, area);
    indexInProvince(key, area);
  };
  for (const a of areas) indexArea(normalizeAreaName(a.name), a);
  for (const al of aliases) {
    const target = byId.get(al.areaId);
    if (target) indexArea(al.fromKey, target);
  }

  const catalog = { version: 0 }; // يزيد مع كل تغيّر: فهارس السيرفي تُعيد توزيع ما فاتها
  const onAreaChanged = (area) => {
    if (!areas.some(a => a.id === area.id)) areas.push(area);
    indexArea(normalizeAreaName(area.name), area);
    invalidateAreaSnapshot();
    catalog.version++;
  };

  const createArea = async (name, province) => {
    const created = await prisma.area.create({
      data: { name, userId: null, provinceId: province.id, needsReview: true },
      select: { id: true, name: true, provinceId: true, needsReview: true },
    });
    stats.newAreas++;
    onAreaChanged(created);
    return created;
  };

  // الاسم عند منطقة بلا محافظة (من رفعة قديمة) ⇒ تُتبنّى بدل التكرار، فيدخل أطباؤها
  // السابقون في منع التكرار أيضاً. وعند محافظة أخرى ⇒ لاحقة تميّزه.
  const placeByName = async (text, key, province) => {
    const holder = anyByKey.get(key);
    if (holder && holder.provinceId == null) {
      const adopted = await prisma.area.update({
        where: { id: holder.id }, data: { provinceId: province.id },
        select: { id: true, name: true, provinceId: true, needsReview: true },
      });
      holder.provinceId = province.id;
      onAreaChanged(adopted);
      return adopted;
    }
    return createArea(holder ? `${text} - ${province.name}` : text, province);
  };

  // عمود المنطقة فارغ أو يحمل اسم المحافظة نفسها ⇒ مركزها (منطق provinceNameCollision)
  const centerOf = async (province) => {
    const center = await findOrCreateProvinceCenter(prisma, province, areas);
    if (center) { onAreaChanged(center); return center; }
    const key = normalizeAreaName(province.name);
    return provinceMap(province.id).get(key) ?? placeByName(province.name, key, province);
  };

  // سيرفي المحافظات منطقته المحافظة نفسها (طلب المستخدم 2026-11-10): «حي الغدير» في
  // كربلاء يُسجَّل «كربلاء» والحيّ يُحفظ في الزون/العنوان. المركز لا اسم المحافظة
  // حرفياً حين يصطدم بحيّ في بغداد (القادسية ⇒ الديوانية) — راجع provinceNameCollision.
  const centers = new Map();
  catalog.center = async (province) => {
    if (!centers.has(province.id)) centers.set(province.id, await centerOf(province));
    return centers.get(province.id);
  };
  catalog.anyByKey = anyByKey;
  catalog.knownNames = () => new Set(areas.map(a => normalizeAreaName(a.name)));
  catalog.stats = stats;
  return catalog;
}

// كل طبيب سيرفي × كل اسم مختلف كان سيعيد تطبيع نفس نصوص المناطق ملايين المرات
// (راجع حادثة 504 في استيراد الزيارات) — أسماء المناطق المختلفة قليلة أصلاً.
const areaKeyMemo = new Map();
function areaKeyOf(text) {
  const s = String(text ?? '');
  let v = areaKeyMemo.get(s);
  if (v === undefined) {
    if (areaKeyMemo.size > 20000) areaKeyMemo.clear();
    v = normalizeAreaName(s);
    areaKeyMemo.set(s, v);
  }
  return v;
}

// ── اختيار محافظة الصف ────────────────────────────────────────────────────────
// مدينة الملف أولاً (الزبون فعلاً هناك)، ثم عنوان يذكر محافظة، ثم منطقة معروفة في
// إحدى محافظات المندوب، وإلا أولى محافظاته.
function provinceForRow(row, areaText, rep, ctx, catalog) {
  const fromCity = ctx.provinceOfText(row.clientCity);
  if (fromCity && fromCity.name !== BAGHDAD_PROVINCE) return fromCity;
  const fromText = ctx.provinceOfText(areaText);
  if (fromText && fromText.name !== BAGHDAD_PROVINCE) return fromText;
  const repProvinces = ctx.provinces.filter(p => rep.provinceIds.has(p.id));
  if (repProvinces.length > 1) {
    const holder = catalog.anyByKey.get(normalizeAreaName(areaText));
    const hit = holder && repProvinces.find(p => p.id === holder.provinceId);
    if (hit) return hit;
  }
  return repProvinces[0] ?? null;
}

// الصف رجع لاسم/عنوان الملف إن كان قد تبنّى هوية طبيب من مسار بغداد قبل اختيار المندوب.
const rowDoctorName = r => String(r.rawDoctorName || r.doctorName || '').trim();
const rowSpecialty  = r => String(r.rawSpecialty ?? r.specialty ?? '').trim();
const rowAreaText   = r => String((r.areaId ? (r.rawAreaText ?? r.areaName) : r.areaName) ?? '').trim();
// صيدلية الطبيب من الملف (عمود associated-client) — لا ما تبنّاه من سجل بغداد.
const rowPharmacy   = r => String(r.rawPharmacyName ?? r.pharmacyName ?? '').trim();

const specialtyConflict = (a, b) => !!a && !!b && normalizeRepName(a) !== normalizeRepName(b);
const sameSpecialty     = (a, b) => !!a && !!b && normalizeRepName(a) === normalizeRepName(b);

/** الحيّ كما كتبه المندوب — يُحفظ في الزون/العنوان. اسم المحافظة نفسها ليس حيّاً. */
function subAreaText(text, province, ctx) {
  const t = String(text ?? '').trim();
  if (!t || ctx.provinceOfText(t)?.id === province.id) return '';
  return t;
}

/**
 * سجلّ صيدليات سيرفي المحافظات، مقسوماً على المحافظات. منطقة صيدلية المحافظة هي
 * المحافظة كلها، فالمطابقة داخل المحافظة. يُستعمل لصفوف زيارات الصيدليات ولصيدلية
 * الطبيب القريبة معاً، فالاسم القانوني واحد ويربط الطرفين في صفحة السيرفي.
 */
async function buildPharmacyRegistry({ surveyId, surveyIds, catalog, ownerUserId, knownNames }) {
  const [surveyPharms, pharmacyAliases] = await Promise.all([
    prisma.masterSurveyPharmacy.findMany({
      where: { surveyId: { in: surveyIds }, isActive: true },
      select: { id: true, name: true, areaName: true, address: true },
    }),
    loadSurveyPharmacyAliases(surveyIds),
  ]);
  const phById = new Map(surveyPharms.map(p => [p.id, p]));
  const provinceOfPharm = p => catalog.anyByKey.get(areaKeyOf(p.areaName))?.provinceId ?? null;
  const nameKey = name => pharmacyDedupKey(name, '').split('::')[0];
  const byProvince = new Map(); // provinceId → { byName: Map, list: [] }
  const bucketOf = (pid) => {
    if (!byProvince.has(pid)) byProvince.set(pid, { byName: new Map(), list: [] });
    return byProvince.get(pid);
  };
  const addPharm = (pid, p) => {
    const b = bucketOf(pid);
    const k = nameKey(p.name);
    if (k && !b.byName.has(k)) b.byName.set(k, p);
    b.list.push(p);
  };
  // عند تغيّر الكتالوج فقط، لا لكل اسم صيدلية
  let unplaced = surveyPharms;
  let placedAtVersion = -1;
  const place = () => {
    if (placedAtVersion === catalog.version) return;
    placedAtVersion = catalog.version;
    unplaced = unplaced.filter(p => {
      const pid = provinceOfPharm(p);
      if (pid == null) return true;
      addPharm(pid, p);
      return false;
    });
  };

  const memo = new Map();
  const stats = { newPharmacies: 0 };
  /** @returns {Promise<{id:number,name:string,areaName:string,address:string|null}>} الصف القانوني */
  const ensure = async (rawName, area, subArea) => {
    const name = normalizePharmacyStoredName(rawName) || rawName;
    const memoKey = `${area.provinceId}|${nameKey(name)}`;
    let match = memo.get(memoKey);
    if (!match) {
      place();
      const bucket = bucketOf(area.provinceId);
      const aliasId = pharmacyAliases.get(pharmacyDedupKey(name, area.name));
      match = (aliasId && phById.get(aliasId)) || bucket.byName.get(nameKey(name)) || null;
      if (!match) {
        let bestScore = 0;
        for (const p of bucket.list) {
          const score = pharmacyMatchScore({ name: p.name, areaName: area.name }, { name, areaName: area.name });
          if (score > bestScore) { bestScore = score; match = p; }
        }
        if (bestScore < PHARMACY_FUZZY_MIN) match = null;
      }
      if (!match) {
        const made = await createSurveyPharmacy(surveyId, { name, areaName: area.name, address: subArea || null }, ownerUserId, knownNames);
        const row = made?.updated ?? made; // صيدلية معطَّلة أُرجعت للعمل تعيد { old, updated }
        match = { id: row.id, name: row.name, areaName: row.areaName, address: row.address ?? null };
        phById.set(match.id, match);
        addPharm(area.provinceId, match);
        if (!made?._duplicate && !made?.updated) stats.newPharmacies++;
      }
      memo.set(memoKey, match);
    }
    // صيدلية سُجّلت بلا عنوان (من صيدلية طبيب) ثم زارها مندوب بعنوان ⇒ يُكمَّل
    if (subArea && !match.address && match.id) {
      match.address = subArea;
      await prisma.masterSurveyPharmacy.update({ where: { id: match.id }, data: { address: subArea } });
    }
    return match;
  };
  return { ensure, stats };
}

/**
 * يجهّز صفوف زيارات المحافظات قبل الحفظ العادي: كل صف يُسجَّل بمنطقة محافظته نفسها
 * (والحيّ في الزون/العنوان)، والطبيب/الصيدلية في السيرفي مرة واحدة، وصيدلية الطبيب
 * القريبة (associated-client) تُسجَّل وتُربط به. الصفوف تُعدَّل في مكانها، وصفوف غير
 * المحافظات لا تُمسّ. فشل صف لا يوقف البقية — يبقى في المسار العادي ويُذكر.
 */
export async function prepareProvinceVisitRows({ doctorRows = [], pharmacyRows = [], ownerUserId }) {
  const empty = { provinceRows: 0, newDoctors: 0, newPharmacies: 0, newAreas: 0, errors: [] };
  const ctx = await loadProvinceVisitContext();
  const docs  = doctorRows.filter(r => rowDoctorName(r) && isProvinceVisitRow(r, ctx));
  const pharm = pharmacyRows.filter(r => String(r?.pharmacyName ?? '').trim() && isProvinceVisitRow(r, ctx));
  if (!docs.length && !pharm.length) return empty;

  const surveyId = await getProvinceSurveyId();
  const catalog  = await buildAreaCatalog(ctx);
  const knownNames = catalog.knownNames();
  const surveys = await prisma.masterSurvey.findMany({ where: { isActive: true }, select: { id: true } });
  const surveyIds = [...new Set([...surveys.map(s => s.id), surveyId])];
  const errors = [];
  let newDoctors = 0;
  const pharmacies = await buildPharmacyRegistry({ surveyId, surveyIds, catalog, ownerUserId, knownNames });

  /** منطقة الصف (المحافظة) + الحيّ + أثره: مندوب زار خارج محافظته تُسند له منطقتها فلا تختفي زيارته. */
  const outsideLinked = new Set();
  const placeRow = async (r) => {
    const rep = ctx.repIndex.get(r.repId);
    const text = rowAreaText(r);
    const province = provinceForRow(r, text, rep, ctx, catalog);
    if (!province) return null;
    const area = await catalog.center(province);
    knownNames.add(normalizeAreaName(area.name));
    if (!rep.provinceIds.has(province.id)) {
      const k = `${rep.userId}|${area.id}`;
      if (!outsideLinked.has(k)) {
        outsideLinked.add(k);
        await prisma.userAreaAssignment.createMany({ data: [{ userId: rep.userId, areaId: area.id }], skipDuplicates: true });
      }
    }
    return { area, subArea: subAreaText(text, province, ctx) };
  };

  // ── الأطباء ───────────────────────────────────────────────────────────────
  if (docs.length) {
    const [surveyDocs, doctorAliases, ownerDoctors] = await Promise.all([
      prisma.masterSurveyDoctor.findMany({
        where: { surveyId: { in: surveyIds }, isActive: true },
        select: { id: true, surveyId: true, name: true, areaName: true, specialty: true, pharmacyName: true, zoneName: true },
      }),
      loadSurveyDoctorAliases(surveyIds),
      prisma.doctor.findMany({
        where: { userId: ownerUserId, masterSurveyDoctorId: { not: null } },
        select: { id: true, masterSurveyDoctorId: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    const doctorRowBySd = new Map();
    for (const d of ownerDoctors) if (!doctorRowBySd.has(d.masterSurveyDoctorId)) doctorRowBySd.set(d.masterSurveyDoctorId, d.id);

    const sdById = new Map(surveyDocs.map(d => [d.id, d]));
    const areaOf = sd => catalog.anyByKey.get(areaKeyOf(sd.areaName)) ?? null;

    const provinceIndexes = new Map(); // provinceId → { byName, index }
    const addToIndex = (provinceId, sd) => {
      if (!provinceIndexes.has(provinceId)) {
        provinceIndexes.set(provinceId, { byName: new Map(), index: buildDoctorNameIndex([]) });
      }
      const pi = provinceIndexes.get(provinceId);
      const k = normalizeRepName(cleanDoctorName(sd.name));
      if (!pi.byName.has(k)) pi.byName.set(k, []);
      pi.byName.get(k).push(sd);
      pi.index.add(sd);
    };
    // يُوزَّع الأطباء على محافظاتهم عند تغيّر الكتالوج لا لكل صف: منطقة قديمة مُتبنّاة
    // تدخل المحافظة أثناء العمل، فيجب أن يراها منع التكرار فوراً.
    const baghdadId = ctx.provinces.find(p => p.name === BAGHDAD_PROVINCE)?.id ?? null;
    let unplaced = surveyDocs;
    let placedAtVersion = -1;
    const provinceIndex = (provinceId) => {
      if (placedAtVersion !== catalog.version) {
        placedAtVersion = catalog.version;
        unplaced = unplaced.filter(sd => {
          const pid = areaOf(sd)?.provinceId;
          if (pid == null) return true;
          if (pid !== baghdadId) addToIndex(pid, sd); // أطباء بغداد لا يُقارَنون هنا إطلاقاً
          return false;
        });
      }
      if (!provinceIndexes.has(provinceId)) {
        provinceIndexes.set(provinceId, { byName: new Map(), index: buildDoctorNameIndex([]) });
      }
      return provinceIndexes.get(provinceId);
    };

    /**
     * المنطقة هي المحافظة كلها، فالفهرس (pi) محصور بها أصلاً. الاسم نفسه يكفي ما لم
     * يتعارض الاختصاص (اسمان متطابقان باختصاصين = شخصان)، والتشابه الإملائي بلا
     * تعارض اختصاص يُربط ويُعرض للمراجعة.
     * @returns {{ sd: object, fuzzy: boolean }|null}
     */
    const findDoctor = (name, specialty, area, pi) => {
      const aliasId = doctorAliases.get(doctorLinkKey(name, area.name));
      if (aliasId && sdById.get(aliasId)) return { sd: sdById.get(aliasId), fuzzy: false };
      const key = normalizeRepName(cleanDoctorName(name));
      const sameName = pi.byName.get(key) ?? [];
      const bySpecialty = sameName.find(d => sameSpecialty(specialty, d.specialty));
      if (bySpecialty) return { sd: bySpecialty, fuzzy: false };
      const noConflict = sameName.find(d => !specialtyConflict(specialty, d.specialty));
      if (noConflict) return { sd: noConflict, fuzzy: false };

      // تهجئة مختلفة قليلاً («عبد الكريم» ↔ «عبدالكريم عليوي»)
      let best = null, bestScore = 0;
      for (const d of pi.index.candidatesFor(name)) {
        if (specialtyConflict(specialty, d.specialty)) continue;
        const score = doctorMatchScore({ name, areaName: area.name, specialty }, { name: d.name, areaName: area.name, specialty: d.specialty });
        if (score > bestScore) { bestScore = score; best = d; }
      }
      if (best && bestScore >= DOCTOR_FUZZY_MIN) return { sd: best, fuzzy: true };
      return null;
    };

    /** يكمّل خانات طبيب السيرفي الفارغة فقط — ما كتبه مستخدم لا يُمسّ. */
    const fillDoctorBlanks = async (sd, { pharmacyName, zoneName }) => {
      const data = {};
      if (pharmacyName && !sd.pharmacyName) data.pharmacyName = pharmacyName;
      if (zoneName && !sd.zoneName) data.zoneName = zoneName;
      if (!Object.keys(data).length) return;
      Object.assign(sd, data);
      await prisma.masterSurveyDoctor.update({ where: { id: sd.id }, data });
      if (data.pharmacyName) {
        await prisma.doctor.updateMany({ where: { masterSurveyDoctorId: sd.id, pharmacyName: null }, data: { pharmacyName: data.pharmacyName } });
      }
    };

    const resolvedByRow = new Map(); // اسم|محافظة|اختصاص → { doctorId, sd } — آلاف الصفوف لنفس الطبيب
    let n = 0;
    for (const r of docs) {
      if (++n % 100 === 0) await new Promise(res => setImmediate(res)); // لا تُحجز حلقة الأحداث
      try {
        const name = cleanDoctorName(rowDoctorName(r));
        const specialty = rowSpecialty(r);
        const placed = await placeRow(r);
        if (!name || !placed) continue;
        const { area, subArea } = placed;

        // صيدلية الطبيب القريبة — تُسجَّل في صيدليات السيرفي باسمها القانوني نفسه
        const nearRaw = rowPharmacy(r);
        const near = nearRaw ? await pharmacies.ensure(nearRaw, area, '') : null;

        const memoKey = `${normalizeRepName(name)}|${area.provinceId}|${normalizeRepName(specialty)}`;
        let hit = resolvedByRow.get(memoKey);
        if (!hit) {
          const pi = provinceIndex(area.provinceId);
          const found = findDoctor(name, specialty, area, pi);
          let sd = found?.sd ?? null;
          if (!sd) {
            sd = await createSurveyDoctor(surveyId, {
              name, specialty: specialty || null, areaName: area.name,
              pharmacyName: near?.name ?? null, zoneName: subArea || null,
            }, ownerUserId, knownNames);
            sdById.set(sd.id, sd);
            addToIndex(area.provinceId, sd);
            newDoctors++;
          }
          let doctorId = doctorRowBySd.get(sd.id);
          if (!doctorId) {
            const created = await prisma.doctor.create({
              data: {
                name: sd.name, specialty: sd.specialty ?? (specialty || null), areaId: areaOf(sd)?.id ?? area.id,
                pharmacyName: sd.pharmacyName ?? near?.name ?? null,
                userId: ownerUserId, masterSurveyDoctorId: sd.id,
              },
              select: { id: true },
            });
            doctorId = created.id;
            doctorRowBySd.set(sd.id, doctorId);
          }
          // الدمج بالتشابه تلقائي بلا سؤال — فيُعرض للمراجعة بعده لا قبله
          if (found?.fuzzy) {
            const fromKey = doctorLinkKey(name, area.name);
            await prisma.doctorNameLink.upsert({
              where: { userId_fromKey: { userId: ownerUserId, fromKey } },
              update: {},
              create: { userId: ownerUserId, fromKey, fromName: name, areaName: area.name, doctorId, confidence: 'fuzzy', needsReview: true },
            });
          }
          hit = { doctorId, sd };
          resolvedByRow.set(memoKey, hit);
        }
        // خانات طبيب سيرفي المحافظات وحده تُكمَّل — لا سيرفي آخر رُبط به عرضاً
        if (hit.sd.surveyId === surveyId || hit.sd.surveyId == null) {
          await fillDoctorBlanks(hit.sd, { pharmacyName: near?.name, zoneName: subArea });
        }

        r.doctorId = hit.doctorId;
        r.doctorName = hit.sd.name;
        r.surveyDoctorId = null;
        r.forceNewDoctor = false;
        r.pharmacyName = hit.sd.pharmacyName || near?.name || '';
        r.pharmacyFromFile = false; // سُجّلت هنا — لا يكتبها الحفظ العادي مرة ثانية
        const sdArea = areaOf(hit.sd) ?? area;
        r.areaId = sdArea.id;
        r.areaName = sdArea.name;
      } catch (e) {
        errors.push(`طبيب محافظة — صف ${r?._row ?? '?'}: ${e.message}`);
      }
    }
  }

  // ── الصيدليات ─────────────────────────────────────────────────────────────
  let n = 0;
  for (const r of pharm) {
    if (++n % 100 === 0) await new Promise(res => setImmediate(res));
    try {
      const placed = await placeRow(r);
      if (!placed) continue;
      const match = await pharmacies.ensure(String(r.pharmacyName).trim(), placed.area, placed.subArea);
      r.pharmacyName = match.name;
      r.areaId = placed.area.id;
      r.areaName = placed.area.name;
    } catch (e) {
      errors.push(`صيدلية محافظة — صف ${r?._row ?? '?'}: ${e.message}`);
    }
  }

  return {
    provinceRows: docs.length + pharm.length, newDoctors, newPharmacies: pharmacies.stats.newPharmacies,
    newAreas: catalog.stats.newAreas, errors,
  };
}

/**
 * ترحيل لمرة واحدة (idempotent، عند الإقلاع): سيرفي المحافظات القديم سُجّل بأحياء
 * («حي الغدير»). يُنقل كل طبيب/صيدلية لمنطقة محافظته والحيّ للزون/العنوان، ومعه
 * صف Doctor المربوط وزيارات الصيدلية بالاسم نفسه — وإلا انفصلت الزيارات عن السيرفي.
 */
export async function migrateProvinceSurveyToProvinceAreas() {
  const survey = await prisma.masterSurvey.findFirst({ where: { description: PROVINCE_SURVEY_DESC }, select: { id: true } });
  if (!survey) return { doctors: 0, pharmacies: 0 };
  const [docs, pharms] = await Promise.all([
    prisma.masterSurveyDoctor.findMany({ where: { surveyId: survey.id }, select: { id: true, name: true, areaName: true, zoneName: true } }),
    prisma.masterSurveyPharmacy.findMany({ where: { surveyId: survey.id }, select: { id: true, name: true, areaName: true, address: true } }),
  ]);
  if (!docs.length && !pharms.length) return { doctors: 0, pharmacies: 0 };

  const ctx = await loadProvinceVisitContext();
  const catalog = await buildAreaCatalog(ctx);
  const provinceById = new Map(ctx.provinces.map(p => [p.id, p]));
  /** المنطقة القديمة + مركز محافظتها، أو null إن كان الصف في مركزها أصلاً */
  const moveOf = async (areaName) => {
    const old = catalog.anyByKey.get(areaKeyOf(areaName));
    const province = old?.provinceId != null ? provinceById.get(old.provinceId) : null;
    if (!province || province.name === BAGHDAD_PROVINCE) return null;
    const center = await catalog.center(province);
    return center.id === old.id ? null : { old, center, province };
  };

  let doctors = 0, pharmacies = 0;
  for (const d of docs) {
    const mv = await moveOf(d.areaName);
    if (!mv) continue;
    await prisma.masterSurveyDoctor.update({
      where: { id: d.id },
      data: { areaName: mv.center.name, zoneName: d.zoneName || subAreaText(d.areaName, mv.province, ctx) || null },
    });
    await prisma.doctor.updateMany({ where: { masterSurveyDoctorId: d.id, areaId: mv.old.id }, data: { areaId: mv.center.id } });
    doctors++;
  }
  for (const p of pharms) {
    const mv = await moveOf(p.areaName);
    if (!mv) continue;
    await prisma.masterSurveyPharmacy.update({
      where: { id: p.id },
      data: { areaName: mv.center.name, address: p.address || subAreaText(p.areaName, mv.province, ctx) || null },
    });
    await prisma.pharmacyVisit.updateMany({
      where: { pharmacyName: p.name, areaId: mv.old.id },
      data: { areaId: mv.center.id, areaName: mv.center.name },
    });
    pharmacies++;
  }
  if (doctors || pharmacies) invalidateAreaSnapshot();
  return { doctors, pharmacies };
}
