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
  },
  masterSurveyEditLog: { create: async () => ({}) },
  masterSurveyDoctorAlias: { findMany: async () => [] },
  masterSurveyPharmacyAlias: { findMany: async () => [] },
  masterSurveyPharmacy: {
    findMany: async () => db.spharm,
    findUnique: async ({ where }) => db.spharm.find(p => p.id === where.id) ?? null,
    create: async ({ data }) => { const p = { id: nextId++, isActive: true, ...data }; db.spharm.push(p); return p; },
  },
  doctor: {
    findMany: async () => db.doctors.filter(d => d.masterSurveyDoctorId != null),
    create: async ({ data }) => { const d = { id: nextId++, ...data }; db.doctors.push(d); return d; },
  },
  doctorNameLink: { upsert: async ({ create }) => { db.links.push(create); return create; } },
  userAreaAssignment: {
    createMany: async ({ data }) => { db.assignments.push(...data); return { count: data.length }; },
    findMany: async () => [],
  },
};

const { prepareProvinceVisitRows, loadProvinceVisitContext, isProvinceVisitRow, markProvinceRows } =
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
  assert.equal(isProvinceVisitRow({ repId: REP_BAGHDAD, clientCity: 'karbala' }, ctx), false);
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
  assert.equal(a.areaName, 'الاسكان');
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
  assert.ok(rows.every(r => r.areaName === 'الاسكان'), 'كل تهجئات العنوان منطقة واحدة');
});

await t('المنطقة: اسم يملكه حيّ ببغداد لا يُخلط — لاحقة المحافظة، وبدائله تصل إليها', async () => {
  const rows = [
    doc(REP_A, 'حيدر الياسري', 'الحسينية', 'عظام'),
    doc(REP_A, 'سرهيد الساعدي', 'ناحية الحسينية', 'اطفال'),
    doc(REP_A, 'عبد الحسين الخفاجي', 'حسينية', 'باطنية'),
  ];
  await run(rows);
  assert.ok(rows.every(r => r.areaName === 'الحسينية - كربلاء'), JSON.stringify(rows.map(r => r.areaName)));
  const area = db.areas.find(x => x.name === 'الحسينية - كربلاء');
  assert.equal(area.provinceId, 2);
  assert.equal(area.needsReview, true, 'منطقة جديدة تصل طابور المراجعة');
  assert.equal(db.areas.find(x => x.id === 1).provinceId, 1, 'حيّ بغداد لم يُمسّ');
  assert.equal(rows[0].areaId, area.id);
});

await t('منطقة قديمة بلا محافظة تُتبنّى، وطبيبها السابق لا يتكرر', async () => {
  const row = doc(REP_B, 'عيادة الدكتور علي حسين حنون', 'طويريج', 'اطفال');
  const res = await run([row]);
  assert.equal(res.newDoctors, 0);
  assert.equal(db.areas.find(a => a.id === 3).provinceId, 2);
  assert.equal(karbalaDocs('علي حسين حنون').length, 1);
  assert.equal(row.doctorName, 'علي حسين حنون');
  assert.equal(row.areaId, 3);
});

await t('بلا عنوان أو بعنوان = اسم المحافظة ⇒ منطقة باسم المحافظة', async () => {
  const rows = [doc(REP_A, 'وسن فيصل حسن', 'karbala', 'نسائية'), doc(REP_A, 'كواكب علي جاسم', '', 'نسائية')];
  await run(rows);
  assert.ok(rows.every(r => r.areaName === 'كربلاء'), JSON.stringify(rows.map(r => r.areaName)));
});

await t('اسم المحافظة بمركز معروف: القادسية ⇒ الديوانية', async () => {
  const row = doc(REP_QADISIYA, 'سعد صاحب الناصر', 'القادسية', 'عظام', { clientCity: '' });
  await run([row]);
  assert.equal(row.areaName, 'الديوانية');
});

await t('الاسم الكامل بعنوان آخر في المحافظة نفس الطبيب؛ الثنائي باختصاص مختلف شخص آخر', async () => {
  const full = [doc(REP_A, 'سعد ابراهيم الغبان', 'الولاية', 'جلدية'), doc(REP_B, 'سعد ابراهيم الغبان', 'حي الحر', 'جلدية')];
  await run(full);
  assert.equal(karbalaDocs('سعد ابراهيم الغبان').length, 1);
  assert.equal(full[0].doctorId, full[1].doctorId);

  const short = [doc(REP_A, 'علي كريم', 'الولاية', 'اطفال'), doc(REP_B, 'علي كريم', 'حي الحر', 'مفاصل')];
  await run(short);
  assert.equal(karbalaDocs('علي كريم').length, 2);
  assert.notEqual(short[0].doctorId, short[1].doctorId);
});

await t('سميّ بمحافظة أخرى أو ببغداد لا يُربط', async () => {
  const row = doc(REP_A, 'سامر كريم', 'الولاية', 'باطنية');
  const res = await run([row]);
  assert.equal(res.newDoctors, 1);
  assert.equal(karbalaDocs('سامر كريم').length, 2);
});

await t('تهجئة قريبة بالمنطقة نفسها تُربط وتذهب لطابور المراجعة؛ باختصاص مختلف لا', async () => {
  const first = doc(REP_A, 'اياد داود سلمان', 'الولاية', 'باطنية');
  await run([first]);
  const variant = doc(REP_B, 'اياد داوود سلمان', 'الولاية', 'باطنية');
  await run([variant]);
  assert.equal(variant.doctorId, first.doctorId);
  assert.equal(db.links.at(-1).confidence, 'fuzzy');
  assert.equal(db.links.at(-1).needsReview, true);

  const other = doc(REP_B, 'اياد داوود سلمان', 'الولاية', 'جلدية');
  await run([other]);
  assert.notEqual(other.doctorId, first.doctorId);
});

await t('الصيدليات: اسم واحد بصيغ مختلفة في المنطقة ⇒ سجل واحد؛ بمنطقة أخرى ⇒ فرع مستقل', async () => {
  const rows = [
    ph(REP_A, 'صيدلية النور', 'الاسكان'),
    ph(REP_B, 'ص. النور', 'اسكان'),
    ph(REP_LEADER, 'النور', 'الاسكان'),
    ph(REP_A, 'صيدلية النور', 'الولاية'),
  ];
  const res = await run([], rows);
  assert.equal(res.newPharmacies, 2);
  assert.equal(rows[0].pharmacyName, rows[1].pharmacyName);
  assert.equal(rows[0].pharmacyName, rows[2].pharmacyName);
  assert.equal(rows[0].areaId, rows[1].areaId);
  assert.notEqual(rows[0].areaId, rows[3].areaId);
});

await t('صفوف بغداد لا تُمسّ، وسيرفي المحافظات يبقى واحداً', async () => {
  const row = doc(REP_BAGHDAD, 'مندوب بغداد طبيب', 'الكرادة', '', { clientCity: 'baghdad', areaId: 2 });
  const res = await run([row]);
  assert.equal(res.provinceRows, 0);
  assert.equal(row.doctorId, undefined);
  assert.equal(row.areaId, 2);
  assert.equal(db.surveys.filter(s => s.name === 'سيرفي المحافظات').length, 1);
});

await t('مندوب زار محافظة أخرى: الطبيب في محافظته الحقيقية وتُسند المنطقة للمندوب كي تظهر زيارته', async () => {
  const row = doc(REP_A, 'جلال علي الكربلائي', 'الكوفة', 'اطفال', { clientCity: 'najaf' });
  await run([row]);
  const area = db.areas.find(a => a.id === row.areaId);
  assert.equal(area.provinceId, 4);
  assert.ok(db.assignments.some(x => x.userId === 11 && x.areaId === area.id));
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
  assert.equal(isForeignAreaVisit(s, 'الكوفة'), true, 'النجف');
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
