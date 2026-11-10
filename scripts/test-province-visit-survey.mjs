// سيرفي المحافظات من الزيارات المرفوعة — npm run test:province-survey
// قاعدة بيانات في الذاكرة عبر globalThis.prisma (lib/prisma.js يعتمدها إن وُجدت).
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';

const db = {
  provinces: [
    { id: 1, name: 'بغداد', aliases: '[]' },
    { id: 2, name: 'كربلاء', aliases: '[]' },
    { id: 3, name: 'القادسية', aliases: '["الديوانية","ديوانية"]' },
    { id: 4, name: 'النجف', aliases: '["نجف"]' },
  ],
  areas: [
    { id: 1, name: 'الحسينية', provinceId: 1, needsReview: false }, // حيّ ببغداد بنفس اسم ناحية كربلاء
    { id: 2, name: 'الكرادة', provinceId: 1, needsReview: false },
    { id: 3, name: 'طويريج', provinceId: null, needsReview: true },  // من رفعة قديمة بلا محافظة
  ],
  surveys: [{ id: 1, name: 'سرفي', description: null, isActive: true }],
  sdoctors: [
    { id: 1, surveyId: 1, name: 'علي حسين حنون', areaName: 'طويريج', specialty: 'اطفال', isActive: true }, // رفعة قديمة
    { id: 2, surveyId: 1, name: 'سامر كريم', areaName: 'الكرادة', specialty: 'باطنية', isActive: true },   // سميّ ببغداد
  ],
  spharm: [],
  doctors: [],
  pvisits: [],
  links: [],
  assignments: [],
};
let nextId = 1000;

globalThis.prisma = {
  province: { findMany: async () => db.provinces },
  provinceTeam: { findMany: async () => [{ leaderUserId: 10, provinceId: 2 }] },
  provinceRepAssignment: {
    findMany: async () => [
      { repUserId: 11, team: { provinceId: 2 } },
      { repUserId: 12, team: { provinceId: 2 } },
      { repUserId: 13, team: { provinceId: 3 } },
    ],
  },
  user: {
    // مسوق المحافظة (provinceScope) يأتي بـprovinceAssignments؛ بقية المستدعين بمعرّف المندوب
    findMany: async ({ where }) => (where?.id?.in
      ? where.id.in.map(id => ({ id, linkedRepId: id + 100 }))
      : [{ id: 14, provinceAssignments: [{ provinceId: 4 }] }]),
    findUnique: async ({ where }) => ({ id: where.id, linkedRepId: where.id + 100, role: 'scientific_rep', permissions: '{}' }),
    findFirst: async ({ where }) => (where?.linkedRepId ? { id: where.linkedRepId - 100 } : null),
  },
  // فريق مدير الشركة لاختبار نطاق المحافظة: مندوبو المحافظات + مندوب بغداد (20)
  userManagerAssignment: {
    findMany: async () => [10, 11, 12, 13, 14, 20].map(id => ({ user: { id, linkedRepId: id + 100, role: 'scientific_rep' } })),
  },
  scientificRepArea: { findMany: async () => [] },
  userProvinceAssignment: { findMany: async () => [] },
  userSubProvinceAssignment: { findMany: async () => [] },
  scientificRepresentative: { findMany: async () => [] },
  masterSurvey: {
    findFirst: async ({ where }) => db.surveys.find(s => s.description === where.description) ?? null,
    findMany: async () => db.surveys.filter(s => s.isActive),
    create: async ({ data }) => { const s = { id: nextId++, ...data }; db.surveys.push(s); return s; },
  },
  area: {
    findMany: async ({ where } = {}) => db.areas.filter(a => {
      if (where?.id?.in && !where.id.in.includes(a.id)) return false;
      const p = where?.provinceId;
      if (typeof p === 'number' && a.provinceId !== p) return false;
      if (p?.in && !p.in.includes(a.provinceId)) return false;
      if (p?.notIn && (a.provinceId == null || p.notIn.includes(a.provinceId))) return false;
      return true;
    }).map(a => ({ ...a })),
    create: async ({ data }) => { const a = { id: nextId++, ...data }; db.areas.push(a); return { ...a }; },
    update: async ({ where, data }) => { const a = db.areas.find(x => x.id === where.id); Object.assign(a, data); return { ...a }; },
  },
  areaAlias: { findMany: async () => [] },
  masterSurveyDoctor: {
    findMany: async () => db.sdoctors.filter(d => d.isActive),
    create: async ({ data }) => { const d = { id: nextId++, isActive: true, ...data }; db.sdoctors.push(d); return d; },
    update: async ({ where, data }) => { const d = db.sdoctors.find(x => x.id === where.id); Object.assign(d, data); return d; },
  },
  masterSurveyEditLog: { create: async () => ({}) },
  masterSurveyDoctorAlias: { findMany: async () => [] },
  masterSurveyPharmacyAlias: { findMany: async () => [] },
  masterSurveyPharmacy: {
    findMany: async () => db.spharm,
    findUnique: async ({ where }) => db.spharm.find(p => p.id === where.id) ?? null,
    create: async ({ data }) => { const p = { id: nextId++, isActive: true, ...data }; db.spharm.push(p); return p; },
    update: async ({ where, data }) => { const p = db.spharm.find(x => x.id === where.id); Object.assign(p, data); return p; },
  },
  pharmacyVisit: {
    updateMany: async ({ where, data }) => {
      const hit = db.pvisits.filter(v => v.pharmacyName === where.pharmacyName && v.areaId === where.areaId);
      hit.forEach(v => Object.assign(v, data));
      return { count: hit.length };
    },
  },
  doctor: {
    findMany: async () => db.doctors.filter(d => d.masterSurveyDoctorId != null),
    create: async ({ data }) => { const d = { id: nextId++, ...data }; db.doctors.push(d); return d; },
    updateMany: async ({ where, data }) => {
      const hit = db.doctors.filter(d => d.masterSurveyDoctorId === where.masterSurveyDoctorId
        && (!('pharmacyName' in where) || (d.pharmacyName ?? null) === where.pharmacyName)
        && (!('areaId' in where) || d.areaId === where.areaId));
      hit.forEach(d => Object.assign(d, data));
      return { count: hit.length };
    },
  },
  doctorNameLink: { upsert: async ({ create }) => { db.links.push(create); return create; } },
  userAreaAssignment: {
    createMany: async ({ data }) => { db.assignments.push(...data); return { count: data.length }; },
    findMany: async () => [],
  },
};

const { prepareProvinceVisitRows, loadProvinceVisitContext, isProvinceVisitRow, markProvinceRows, migrateProvinceSurveyToProvinceAreas } =
  await import('../server/lib/provinceVisitSurvey.js');

const OWNER = 99;
const REP_A = 111, REP_B = 112, REP_LEADER = 110, REP_QADISIYA = 113, REP_MARKETER = 114, REP_BAGHDAD = 500;

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`✓ ${name}`); };

const doc = (repId, doctorName, area, specialty = '', extra = {}) =>
  ({ _row: 1, repId, repName: 'x', doctorName, specialty, areaName: area, areaId: null, clientCity: 'karbala', ...extra });
const ph = (repId, pharmacyName, area, extra = {}) =>
  ({ _row: 1, repId, repName: 'x', pharmacyName, areaName: area, areaId: null, clientCity: 'karbala', ...extra });
const run = (doctorRows = [], pharmacyRows = []) => prepareProvinceVisitRows({ doctorRows, pharmacyRows, ownerUserId: OWNER });
const karbalaDocs = name => db.sdoctors.filter(d => d.name === name);

await t('التمييز: مندوب/قائد/مسوق محافظة نعم، بغداد لا، وزبون بغداد يبقى في مسار بغداد', async () => {
  const ctx = await loadProvinceVisitContext();
  assert.equal(isProvinceVisitRow({ repId: REP_A, clientCity: 'karbala' }, ctx), true);
  assert.equal(isProvinceVisitRow({ repId: REP_LEADER }, ctx), true);
  assert.equal(isProvinceVisitRow({ repId: REP_MARKETER }, ctx), true);
  // مدينة الملف هي الحَكَم: مندوب بغداد زار كربلاء ⇒ زيارة محافظة
  assert.equal(isProvinceVisitRow({ repId: REP_BAGHDAD, clientCity: 'karbala' }, ctx), true);
  assert.equal(isProvinceVisitRow({ repId: REP_BAGHDAD, repCity: 'alnajaf' }, ctx), true);
  assert.equal(isProvinceVisitRow({ repId: REP_BAGHDAD }, ctx), false);
  assert.equal(isProvinceVisitRow({ repId: REP_A, clientCity: 'baghdad', repCity: 'karbala' }, ctx), false);
  assert.equal(isProvinceVisitRow({ repId: REP_A, clientCity: 'Baghdad' }, ctx), false);
  assert.equal(isProvinceVisitRow({ repId: null }, ctx), false);
});

await t('الاستخراج: صف المحافظة يرجع لنص الملف ولا يبقى على منطقة بغداد', async () => {
  const ctx = await loadProvinceVisitContext();
  const rows = [
    { repId: REP_A, areaName: 'الحسينية', areaId: 1, rawAreaText: 'ناحية الحسينية', clientCity: 'karbala' },
    { repId: REP_BAGHDAD, areaName: 'الكرادة', areaId: 2, rawAreaText: 'الكرادة', clientCity: 'baghdad' },
  ];
  markProvinceRows(rows, ctx);
  assert.equal(rows[0].areaId, null);
  assert.equal(rows[0].areaName, 'ناحية الحسينية');
  assert.equal(rows[1].areaId, 2);
  assert.equal(rows[1].baghdadClient, true);
});

const sdOf = row => db.sdoctors.find(d => db.doctors.find(x => x.id === row.doctorId)?.masterSurveyDoctorId === d.id);

await t('طلب المستخدم: مندوبان يرفعان الاسم نفسه ⇒ طبيب واحد وزيارتان تحته', async () => {
  const a = doc(REP_A, 'قحطان علي العبيدي', 'الاسكان', 'اطفال');
  const b = doc(REP_B, 'قحطان علي العبيدي', 'الاسكان', 'اطفال');
  const res = await run([a], []);
  const res2 = await run([b], []);
  assert.equal(res.newDoctors, 1);
  assert.equal(res2.newDoctors, 0);
  assert.equal(karbalaDocs('قحطان علي العبيدي').length, 1);
  assert.equal(a.doctorId, b.doctorId);
  assert.ok(a.doctorId);
});

await t('طلب المستخدم 2026-11-10: منطقة الطبيب = محافظة المندوب، والحيّ في الزون', async () => {
  const sd = karbalaDocs('قحطان علي العبيدي')[0];
  assert.equal(sd.areaName, 'كربلاء');
  assert.equal(sd.zoneName, 'الاسكان');
  const row = doc(REP_A, 'هديل الشوك', 'حي الغدير', 'نسائية وتوليد');
  await run([row]);
  assert.equal(row.areaName, 'كربلاء');
  assert.equal(sdOf(row).zoneName, 'حي الغدير');
});

await t('الاسم نفسه داخل الملف الواحد وبصيغة «عيادة الدكتور» لا يتكرر', async () => {
  const rows = [
    doc(REP_A, 'عيادة الدكتور حيدر صبحي', 'الاسكان', 'باطنية'),
    doc(REP_B, 'د. حيدر صبحي', 'اسكان', 'باطنية'),
    doc(REP_LEADER, 'حيدر صبحي', 'شارع الاسكان', 'باطنية'),
  ];
  const res = await run(rows);
  assert.equal(res.newDoctors, 1);
  assert.equal(new Set(rows.map(r => r.doctorId)).size, 1);
  assert.ok(rows.every(r => r.areaName === 'كربلاء'));
});

await t('حيّ يحمل اسم حيّ ببغداد: لا منطقة جديدة ولا خلط — المحافظة نفسها', async () => {
  const rows = [doc(REP_A, 'حيدر الياسري', 'الحسينية', 'عظام'), doc(REP_A, 'سرهيد الساعدي', 'ناحية الحسينية', 'اطفال')];
  const before = db.areas.length;
  await run(rows);
  assert.ok(rows.every(r => r.areaName === 'كربلاء'), JSON.stringify(rows.map(r => r.areaName)));
  assert.equal(db.areas.length, before);
  assert.equal(db.areas.find(x => x.id === 1).provinceId, 1, 'حيّ بغداد لم يُمسّ');
  assert.equal(sdOf(rows[1]).zoneName, 'ناحية الحسينية');
});

await t('بلا عنوان أو بعنوان = اسم المحافظة ⇒ منطقة باسم المحافظة وزون فارغ', async () => {
  const rows = [doc(REP_A, 'وسن فيصل حسن', 'karbala', 'نسائية'), doc(REP_A, 'كواكب علي جاسم', '', 'نسائية')];
  await run(rows);
  assert.ok(rows.every(r => r.areaName === 'كربلاء'), JSON.stringify(rows.map(r => r.areaName)));
  assert.ok(rows.every(r => !sdOf(r).zoneName));
});

await t('اسم المحافظة بمركز معروف: القادسية ⇒ الديوانية', async () => {
  const row = doc(REP_QADISIYA, 'سعد صاحب الناصر', 'القادسية', 'عظام', { clientCity: '' });
  await run([row]);
  assert.equal(row.areaName, 'الديوانية');
});

await t('الاسم نفسه بحيّ آخر في المحافظة نفس الطبيب؛ باختصاص مختلف شخص آخر', async () => {
  const full = [doc(REP_A, 'سعد ابراهيم الغبان', 'الولاية', 'جلدية'), doc(REP_B, 'سعد ابراهيم الغبان', 'حي الحر', 'جلدية')];
  await run(full);
  assert.equal(karbalaDocs('سعد ابراهيم الغبان').length, 1);
  assert.equal(full[0].doctorId, full[1].doctorId);

  const short = [doc(REP_A, 'علي كريم', 'الولاية', 'اطفال'), doc(REP_B, 'علي كريم', 'حي الحر', 'مفاصل')];
  await run(short);
  assert.equal(karbalaDocs('علي كريم').length, 2);
  assert.notEqual(short[0].doctorId, short[1].doctorId);
});

await t('سميّ ببغداد لا يُربط', async () => {
  const row = doc(REP_A, 'سامر كريم', 'الولاية', 'باطنية');
  const res = await run([row]);
  assert.equal(res.newDoctors, 1);
  assert.equal(karbalaDocs('سامر كريم').length, 2);
});

await t('تهجئة قريبة تُربط وتذهب لطابور المراجعة؛ باختصاص مختلف لا', async () => {
  const first = doc(REP_A, 'اياد داود سلمان', 'الولاية', 'باطنية');
  await run([first]);
  const variant = doc(REP_B, 'اياد داوود سلمان', 'حي الحر', 'باطنية');
  await run([variant]);
  assert.equal(variant.doctorId, first.doctorId);
  assert.equal(db.links.at(-1).confidence, 'fuzzy');
  assert.equal(db.links.at(-1).needsReview, true);

  const other = doc(REP_B, 'اياد داوود سلمان', 'الولاية', 'جلدية');
  await run([other]);
  assert.notEqual(other.doctorId, first.doctorId);
});

await t('الصيدليات: صيغ الاسم نفسه في المحافظة ⇒ سجل واحد بمنطقة المحافظة والحيّ في العنوان', async () => {
  const rows = [
    ph(REP_A, 'صيدلية النور', 'الاسكان'),
    ph(REP_B, 'ص. النور', 'اسكان'),
    ph(REP_LEADER, 'النور', 'الولاية'),
  ];
  const res = await run([], rows);
  assert.equal(res.newPharmacies, 1);
  assert.equal(new Set(rows.map(r => r.pharmacyName)).size, 1);
  assert.ok(rows.every(r => r.areaName === 'كربلاء'));
  const p = db.spharm.find(x => x.name === rows[0].pharmacyName);
  assert.equal(p.areaName, 'كربلاء');
  assert.equal(p.address, 'الاسكان');
});

await t('طلب المستخدم: صيدلية الطبيب القريبة تُسجَّل وتُربط به، وأطباء الصيدلية يظهرون تحتها', async () => {
  const d1 = doc(REP_A, 'علاء جلاب مطر', 'حي الغدير', 'انف واذن وحنجرة', { pharmacyName: 'صيدلية الاحسان' });
  const d2 = doc(REP_B, 'نورا الحميري', 'حي العامل', 'نسائية وتوليد', { pharmacyName: 'صيدلية  الاحسان' });
  const res = await run([d1, d2]);
  assert.equal(res.newPharmacies, 1);
  const p = db.spharm.find(x => x.name === sdOf(d1).pharmacyName);
  assert.ok(p, 'الصيدلية في السيرفي');
  assert.equal(p.areaName, 'كربلاء');
  assert.equal(sdOf(d2).pharmacyName, p.name, 'الاسم القانوني نفسه ⇒ الطبيبان تحت الصيدلية');
  assert.equal(db.doctors.find(x => x.id === d1.doctorId).pharmacyName, p.name);
  assert.equal(d1.pharmacyFromFile, false);

  // زيارة الصيدلية نفسها لاحقاً: لا سجل جديد، ويُكمَّل عنوانها
  const visit = ph(REP_A, 'صيدلية الاحسان', 'حي الغدير');
  const res2 = await run([], [visit]);
  assert.equal(res2.newPharmacies, 0);
  assert.equal(visit.pharmacyName, p.name);
  assert.equal(p.address, 'حي الغدير');
});

await t('طبيب مسجَّل بلا صيدلية يكتسبها من رفعة لاحقة، ولا تُستبدل صيدلية موجودة', async () => {
  const later = doc(REP_A, 'قحطان علي العبيدي', 'الاسكان', 'اطفال', { pharmacyName: 'صيدلية فدك' });
  await run([later]);
  const sd = karbalaDocs('قحطان علي العبيدي')[0];
  assert.equal(sd.pharmacyName, 'فدك');
  const again = doc(REP_B, 'قحطان علي العبيدي', 'الاسكان', 'اطفال', { pharmacyName: 'صيدلية اوزون' });
  await run([again]);
  assert.equal(sd.pharmacyName, 'فدك');
});

await t('صفوف بغداد لا تُمسّ، وسيرفي المحافظات يبقى واحداً', async () => {
  const row = doc(REP_BAGHDAD, 'مندوب بغداد طبيب', 'الكرادة', '', { clientCity: 'baghdad', areaId: 2 });
  const res = await run([row]);
  assert.equal(res.provinceRows, 0);
  assert.equal(row.doctorId, undefined);
  assert.equal(row.areaId, 2);
  assert.equal(db.surveys.filter(s => s.name === 'سيرفي المحافظات').length, 1);
});

await t('مندوب زار محافظة أخرى: الطبيب في محافظته الحقيقية وتُسند منطقتها للمندوب كي تظهر زيارته', async () => {
  const row = doc(REP_A, 'جلال علي الكربلائي', 'الكوفة', 'اطفال', { clientCity: 'najaf' });
  await run([row]);
  const area = db.areas.find(a => a.id === row.areaId);
  assert.equal(area.provinceId, 4);
  assert.ok(db.assignments.some(x => x.userId === 11 && x.areaId === area.id));
});

await t('طلب المستخدم 2026-11-10: مدينة الملف تحسم — مندوب بغداد زار كربلاء ⇒ سيرفي المحافظات بلا مطابقة بغداد', async () => {
  const row = doc(REP_BAGHDAD, 'سامر كريم', 'الكرادة', 'باطنية', { clientCity: 'karbala', areaId: 2 });
  const res = await run([row]);
  assert.equal(res.provinceRows, 1);
  const area = db.areas.find(a => a.id === row.areaId);
  assert.equal(area.provinceId, 2); // كربلاء لا حيّ الكرادة ببغداد
  assert.notEqual(row.surveyDoctorId ?? row.doctorId, 2); // لا يُربط بسميّ بغداد
  assert.ok(db.assignments.some(x => x.userId === REP_BAGHDAD - 100 && x.areaId === area.id));
});

await t('إعادة رفع الملف نفسه: صفر سجلات جديدة', async () => {
  const before = { d: db.sdoctors.length, p: db.spharm.length, a: db.areas.length, r: db.doctors.length };
  const res = await run(
    [doc(REP_B, 'قحطان علي العبيدي', 'الاسكان', 'اطفال'), doc(REP_A, 'حيدر الياسري', 'الحسينية', 'عظام')],
    [ph(REP_B, 'صيدلية النور', 'الاسكان')],
  );
  assert.equal(res.newDoctors + res.newPharmacies + res.newAreas, 0);
  assert.deepEqual({ d: db.sdoctors.length, p: db.spharm.length, a: db.areas.length, r: db.doctors.length }, before);
});

await t('ترحيل السيرفي القديم: الحيّ ⇒ المحافظة والزون/العنوان، ومعه صف الطبيب وزيارات الصيدلية', async () => {
  const survey = db.surveys.find(s => s.name === 'سيرفي المحافظات');
  const old = { id: 9001, name: 'محمد شريم', provinceId: 2, needsReview: true };
  db.areas.push({ id: 9001, name: 'حي المعلمين', provinceId: 2, needsReview: true });
  db.sdoctors.push({ id: 9002, surveyId: survey.id, name: old.name, areaName: 'حي المعلمين', specialty: 'باطنية', isActive: true });
  db.doctors.push({ id: 9003, masterSurveyDoctorId: 9002, areaId: 9001 });
  db.spharm.push({ id: 9004, surveyId: survey.id, name: 'صيدلية كرم الحسن', areaName: 'حي المعلمين', address: null, isActive: true });
  db.pvisits.push({ id: 9005, pharmacyName: 'صيدلية كرم الحسن', areaId: 9001, areaName: 'حي المعلمين' });

  const res = await migrateProvinceSurveyToProvinceAreas();
  assert.ok(res.doctors >= 1 && res.pharmacies >= 1, JSON.stringify(res));
  const center = db.areas.find(a => a.name === 'كربلاء' && a.provinceId === 2);
  const sd = db.sdoctors.find(d => d.id === 9002);
  assert.equal(sd.areaName, 'كربلاء');
  assert.equal(sd.zoneName, 'حي المعلمين');
  assert.equal(db.doctors.find(d => d.id === 9003).areaId, center.id);
  assert.equal(db.spharm.find(p => p.id === 9004).address, 'حي المعلمين');
  assert.equal(db.pvisits[0].areaId, center.id);

  const again = await migrateProvinceSurveyToProvinceAreas();
  assert.deepEqual(again, { doctors: 0, pharmacies: 0 }, 'idempotent');
});

const { resolveAreaScope, isForeignAreaVisit } = await import('../server/lib/surveyDoctors.js');
const manager = { id: 1, role: 'company_manager' };
const sorted = list => [...list].sort((a, b) => a - b);

await t('اختيار محافظة: مندوبوها وحدهم ومناطقها وحدها، وزيارة محافظة أخرى خارج العرض', async () => {
  const s = await resolveAreaScope(manager, { provinceScope: 'province', provinceId: 2 });
  assert.deepEqual(sorted(s.memberRepIds), sorted([REP_LEADER, REP_A, REP_B]));
  assert.ok(s.areaRecords.length > 0);
  const karbalaIds = new Set(db.areas.filter(a => a.provinceId === 2).map(a => a.id));
  assert.ok(s.areaRecords.every(a => karbalaIds.has(a.id)));
  assert.equal(isForeignAreaVisit(s, 'الكرادة'), true, 'بغداد');
  assert.equal(isForeignAreaVisit(s, db.areas.find(a => a.provinceId === 4).name), true, 'النجف');
  assert.equal(isForeignAreaVisit(s, 'الاسكان'), false);
  assert.equal(isForeignAreaVisit(s, null), false);
});

await t('محافظة أخرى تعطي مندوبيها هي، وعرض كل المحافظات يجمعهم بلا بغداد', async () => {
  const q = await resolveAreaScope(manager, { provinceScope: 'province', provinceId: 3 });
  assert.deepEqual(q.memberRepIds, [REP_QADISIYA]);
  const all = await resolveAreaScope(manager, { provinceScope: 'province' });
  assert.deepEqual(sorted(all.memberRepIds), sorted([REP_LEADER, REP_A, REP_B, REP_QADISIYA, REP_MARKETER]));
  assert.equal(all.foreignAreaKeys, null);
  assert.equal(isForeignAreaVisit(all, 'الكرادة'), false);
});

await t('عرض بغداد لا يتأثر بفلتر المحافظة', async () => {
  const b = await resolveAreaScope(manager, { provinceScope: 'baghdad' });
  assert.ok(b.memberRepIds.includes(120));
  assert.ok(!b.memberRepIds.includes(REP_A));
});

console.log(`\n${passed} اختبار نجح`);
process.exit(0);
