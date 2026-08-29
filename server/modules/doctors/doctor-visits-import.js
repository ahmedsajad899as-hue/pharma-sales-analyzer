/**
 * استيراد زيارات الأطباء والصيدليات بالجملة من ملف إكسل خارجي — بديل عن
 * تسجيلها يدوياً واحدة تلو الأخرى من داخل التطبيق.
 *
 * يدعم صيغتين للملف (تُكتشَف تلقائياً من ترويسات الأعمدة):
 *   • القالب البسيط (نموذجنا القابل للتحميل من داخل التطبيق) — أعمدة عربية
 *     صريحة (اسم المندوب/اسم الطبيب/الاختصاص...) → زيارات أطباء فقط.
 *   • تصدير CRM خارجي (task-to/client/client-category...) — ملف واحد يخلط
 *     زيارات أطباء وصيدليات معاً، يُميَّز بينها بعمود client-category؛ يُقسَّم
 *     هنا إلى قائمتين منفصلتين لأن DoctorVisit وPharmacyVisit نموذجان مختلفان
 *     تماماً (لا طبيب في زيارة الصيدلية، ولا "اختصاص" لها).
 *
 * تدفّق العمل على مرحلتين (مطابق لنمط ManualSalesModal):
 *   1) extractVisitsFromExcel — يقرأ الملف، يحاول مطابقة كل حقل تلقائياً، ويُعيد
 *      الصفوف (أطباء + صيدليات) للمراجعة — لا يُنشئ شيئاً.
 *   2) commitVisitsImport — يأخذ الصفوف بعد مراجعة المستخدم وتصحيحها، وينشئ
 *      صفوف Doctor الناقصة + DoctorVisit/PharmacyVisit فعلياً.
 *
 * مطابقة اسم المندوب تُعاد استعمالها من محرّك ميركاتو (classifyRepNamesForUser)
 * عمداً: نفس السؤال بالضبط ("هل هذا الاسم الحر هو المندوب فلان؟")، وأي رابط
 * يؤكّده المستخدم هنا يُطبَّق تلقائياً لاحقاً في ميركاتو أو أي استيراد آخر.
 */

import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';
import fs from 'fs';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import { resolveDocOwnerUserId } from './doctors.controller.js';
import { classifyRepNamesForUser, normalizeRepName, saveRepNameLinks } from '../scientific-reps/scientific-reps.service.js';
import { createSurveyDoctor } from '../../lib/surveyDoctors.js';

// ── تعيين نص الفيدباك الحر إلى قيم Enum الثابتة في DoctorVisit.feedback ──────
const FEEDBACK_RULES = [
  [/كتاب|writing/i,                         'writing'],
  [/مخزن|تخزين|متوفر|stock/i,                'stocked'],
  [/غير\s*مهتم|not[\s_]*interested/i,        'not_interested'],
  [/مهتم|interested/i,                       'interested'],
  [/غير\s*متوفر|unavailable/i,               'unavailable'],
];
function mapFeedback(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'pending';
  for (const [re, val] of FEEDBACK_RULES) if (re.test(s)) return val;
  return 'pending';
}

const COL_KEYWORDS = {
  repName:   ['اسم المندوب', 'المندوب', 'rep name', 'sales rep', 'rep'],
  doctor:    ['اسم الطبيب', 'اسم الدكتور', 'الطبيب', 'الدكتور', 'doctor name', 'doctor'],
  specialty: ['الاختصاص', 'التخصص', 'اختصاص', 'تخصص', 'specialty', 'speciality'],
  area:      ['المنطقة', 'منطقة', 'المنطقه', 'منطقه', 'area', 'zone', 'region'],
  pharmacy:  ['اسم الصيدلية', 'الصيدلية', 'صيدلية', 'صيدليه', 'pharmacy'],
  item:      ['اسم الايتم', 'الايتم', 'ايتم', 'المادة', 'الماده', 'item', 'drug', 'product'],
  date:      ['تاريخ الزيارة', 'التاريخ', 'تاريخ', 'date'],
  feedback:  ['الفيدباك', 'فيدباك', 'نتيجة الزيارة', 'النتيجة', 'feedback', 'result'],
  notes:     ['الملاحظات', 'ملاحظات', 'ملاحظة', 'notes', 'note'],
  lat:       ['خط العرض', 'latitude', 'lat'],
  lng:       ['خط الطول', 'longitude', 'lng', 'long'],
  location:  ['الموقع', 'الإحداثيات', 'الاحداثيات', 'location', 'gps', 'coordinates'],
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

function parseVisitDate(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') { // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (dmy) { const d = new Date(+dmy[3], +dmy[2] - 1, +dmy[1]); if (!isNaN(d.getTime())) return d; }
  const ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (ymd) { const d = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]); if (!isNaN(d.getTime())) return d; }
  const generic = new Date(s);
  return isNaN(generic.getTime()) ? null : generic;
}

function parseLocation(row, colMap) {
  let lat = colMap.lat ? Number(row[colMap.lat]) : NaN;
  let lng = colMap.lng ? Number(row[colMap.lng]) : NaN;
  if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && colMap.location) {
    const raw = String(row[colMap.location] ?? '').trim();
    const m = raw.match(/(-?\d+(?:\.\d+)?)\s*[,،]\s*(-?\d+(?:\.\d+)?)/);
    if (m) { lat = Number(m[1]); lng = Number(m[2]); }
  }
  return { lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null };
}

function findByName(list, val) {
  if (!val) return null;
  const v = String(val).trim().toLowerCase();
  if (!v) return null;
  return list.find(x => x.name.trim().toLowerCase() === v)
      || list.find(x => x.name.toLowerCase().includes(v) || v.includes(x.name.toLowerCase()))
      || null;
}

// ════════════════════════════════════════════════════════════════════════════
// صيغة تصدير CRM خارجي (task-to/client/client-category…)
// ════════════════════════════════════════════════════════════════════════════

// توقيع الصيغة: هذه الأعمدة الثلاثة معاً لا تظهر في القالب البسيط إطلاقاً.
const CRM_SIGNATURE = ['task-to', 'client', 'client-category'];
function detectCrmFormat(headers) {
  const lower = headers.map(h => String(h).trim().toLowerCase());
  return CRM_SIGNATURE.every(c => lower.includes(c));
}

/**
 * بعض أعمدة CRM تخلط الاسم بمعلومات إضافية بفاصل ("الاسم - المدينة" أو
 * "الاسم / الشركة / المنطقة") — نأخذ المقطع الأول فقط قبل أول فاصل.
 */
function leadingSegment(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(.+?)\s*[/\-–]\s*\S.*$/);
  return m ? m[1].trim() : s;
}

const PHARMACY_NAME_RE = /^(صيدلية|صيدليه|ص[.\s])/;
const DOCTOR_NAME_RE   = /(دكتور|عيادة|د\.)/;

/** يقرأ صفوف صيغة CRM ويقسّمها إلى زيارات أطباء وزيارات صيدليات منفصلة. */
function extractCrmRows({ rows, headers, repByKey, allAreas, existingDoctors }) {
  const col = {
    taskTo:      findCol(headers, ['task-to']),
    client:      findCol(headers, ['client']),
    category:    findCol(headers, ['client-category']),
    subcategory: findCol(headers, ['client-subcategory']),
    address:     findCol(headers, ['client-address']),
    city:        findCol(headers, ['client-city']),
    associated:  findCol(headers, ['associated-client']),
    type:        findCol(headers, ['type']),
    created:     findCol(headers, ['created']),
    note:        findCol(headers, ['note']),
  };
  const get = (row, key) => (col[key] ? String(row[col[key]] ?? '').trim() : '');

  const doctorRows = [];
  const pharmacyRows = [];

  rows.forEach((row, i) => {
    const clientRaw = get(row, 'client');
    if (!clientRaw) return; // صفوف مثل Check-Out بلا عميل — لا معنى لاستيرادها

    const repName = leadingSegment(get(row, 'taskTo'));
    const repKey  = repName ? normalizeRepName(repName) : '';
    const rep     = repKey ? repByKey.get(repKey) : null;

    const clientName = leadingSegment(clientRaw);
    let category = get(row, 'category');
    if (!category || category.toLowerCase() === 'unset') {
      category = PHARMACY_NAME_RE.test(clientName) ? 'صيدلية'
               : DOCTOR_NAME_RE.test(clientName)   ? 'دكتور'
               : '';
    }

    const areaRaw = get(row, 'address') || get(row, 'city');
    const area = findByName(allAreas, areaRaw);
    const dateVal = parseVisitDate(get(row, 'created'));
    const date = dateVal ? dateVal.toISOString().slice(0, 10) : '';
    const isDoubleVisit = get(row, 'type') === 'Double Visit';
    const notes = get(row, 'note');
    const _row = i + 2;

    if (category.includes('صيدل')) {
      pharmacyRows.push({
        _row, repName, repId: rep?.id ?? null,
        pharmacyName: clientName,
        areaName: areaRaw, areaId: area?.id ?? null,
        date, notes, isDoubleVisit,
        lat: null, lng: null,
      });
    } else {
      // فئة غير محسومة (لا "دكتور" صريحة ولا شبه اسم صيدلية) تُعامَل كطبيب
      // افتراضياً لتبقى قابلة للمراجعة بدل إسقاطها صامتة.
      const sameNameDoctors = existingDoctors.filter(d => d.name.trim().toLowerCase() === clientName.toLowerCase());
      const existingDoctor = area
        ? (sameNameDoctors.find(d => d.areaId === area.id) ?? sameNameDoctors[0] ?? null)
        : (sameNameDoctors[0] ?? null);
      doctorRows.push({
        _row, repName, repId: rep?.id ?? null,
        doctorName: clientName, doctorId: existingDoctor?.id ?? null,
        specialty: get(row, 'subcategory'),
        areaName: areaRaw, areaId: area?.id ?? null,
        pharmacyName: get(row, 'associated'),
        itemName: '', itemId: null,
        date,
        feedback: 'pending', // لا مصدر واثق للفيدباك في نص هذه الصيغة الحر
        notes, isDoubleVisit,
        lat: null, lng: null,
      });
    }
  });

  return { doctorRows, pharmacyRows };
}

// ════════════════════════════════════════════════════════════════════════════
// EXTRACT (مشترك بين الصيغتين)
// ════════════════════════════════════════════════════════════════════════════

/**
 * قراءة الملف ومحاولة مطابقة كل حقل — بلا إنشاء أي شيء. النتيجة صفوف تُعرض
 * لمراجعة المستخدم في شبكة قابلة للتعديل قبل الحفظ الفعلي. يكتشف صيغة الملف
 * تلقائياً (قالبنا البسيط أو تصدير CRM خارجي) ويُرجع شكلاً موحّداً دائماً
 * (doctorRows + pharmacyRows) بصرف النظر عن الصيغة.
 */
export async function extractVisitsFromExcel(file, user) {
  const workbook = XLSX.readFile(file.path);
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  fs.unlink(file.path, () => {});

  const EMPTY = { doctorRows: [], pharmacyRows: [], repNames: { pending: [], resolved: [], unrelated: [], reps: [] }, format: 'template', columnsDetected: {} };
  if (rows.length === 0) return EMPTY;

  const headers = Object.keys(rows[0]);
  const isCrm = detectCrmFormat(headers);
  const ownerUserId = await resolveDocOwnerUserId(user.id);

  // استخراج أسماء المندوبين حسب الصيغة (قبل التصنيف) — مشترك بين قائمتي
  // الأطباء والصيدليات لأنه نفس عمود المندوب في الملف نفسه.
  let colMap = {};
  let rawRepNames = [];
  if (isCrm) {
    const taskToCol = findCol(headers, ['task-to']);
    rawRepNames = taskToCol
      ? [...new Set(rows.map(r => leadingSegment(r[taskToCol])).filter(Boolean))]
      : [];
  } else {
    for (const [field, kws] of Object.entries(COL_KEYWORDS)) colMap[field] = findCol(headers, kws);
    rawRepNames = colMap.repName
      ? [...new Set(rows.map(r => String(r[colMap.repName] ?? '').trim()).filter(Boolean))]
      : [];
  }

  const repClassification = await classifyRepNamesForUser(rawRepNames, user);
  const repByKey = new Map();
  for (const e of [...repClassification.pending, ...repClassification.resolved]) {
    if (e.rep) repByKey.set(e.key, e.rep);
  }

  const [allAreas, allItems, existingDoctors] = await Promise.all([
    prisma.area.findMany({ select: { id: true, name: true } }),
    prisma.item.findMany({ where: { userId: ownerUserId }, select: { id: true, name: true } }),
    prisma.doctor.findMany({ where: { userId: ownerUserId }, select: { id: true, name: true, areaId: true } }),
  ]);

  if (isCrm) {
    const { doctorRows, pharmacyRows } = extractCrmRows({ rows, headers, repByKey, allAreas, existingDoctors });
    return { doctorRows, pharmacyRows, repNames: repClassification, format: 'crm', columnsDetected: {} };
  }

  const doctorRows = rows.map((row, i) => {
    const get = field => (colMap[field] ? String(row[colMap[field]] ?? '').trim() : '');

    const repRaw = get('repName');
    const repKey = repRaw ? normalizeRepName(repRaw) : '';
    const rep = repKey ? repByKey.get(repKey) : null;

    const doctorName = get('doctor');
    const areaName   = get('area');
    const area = findByName(allAreas, areaName);

    const sameNameDoctors = doctorName
      ? existingDoctors.filter(d => d.name.trim().toLowerCase() === doctorName.toLowerCase())
      : [];
    const existingDoctor = area
      ? (sameNameDoctors.find(d => d.areaId === area.id) ?? sameNameDoctors[0] ?? null)
      : (sameNameDoctors[0] ?? null);

    const itemName = get('item');
    const item = findByName(allItems, itemName);
    const { lat, lng } = parseLocation(row, colMap);
    const dateVal = parseVisitDate(get('date'));

    return {
      _row: i + 2, // رقم صف الإكسل (1 = الترويسة)
      repName: repRaw, repId: rep?.id ?? null,
      doctorName, doctorId: existingDoctor?.id ?? null,
      specialty: get('specialty'),
      areaName, areaId: area?.id ?? null,
      pharmacyName: get('pharmacy'),
      itemName, itemId: item?.id ?? null,
      date: dateVal ? dateVal.toISOString().slice(0, 10) : '',
      feedback: mapFeedback(get('feedback')),
      notes: get('notes'), isDoubleVisit: false,
      lat, lng,
    };
  }).filter(r => r.doctorName); // صف بلا اسم طبيب لا معنى لاستيراده كزيارة

  return { doctorRows, pharmacyRows: [], repNames: repClassification, format: 'template', columnsDetected: colMap };
}

// ════════════════════════════════════════════════════════════════════════════
// COMMIT
// ════════════════════════════════════════════════════════════════════════════

/**
 * يحفظ صفوف زيارات الأطباء بعد مراجعة/تصحيح المستخدم: يُنشئ Doctor الناقص
 * (بنفس منطق تسجيل الزيارة اليدوي — إكمال الحقول الفارغة فقط لا استبدال
 * الموجود)، ثم DoctorVisit. صف بلا مندوب مؤكَّد (repId) يُتجاهل ويُذكر في
 * الأخطاء — لا نخمّن مندوباً.
 *
 * ⚠️ شاشة «الزيارات» لا تُبنى من DoctorVisit مباشرة — تُبنى من أطباء السيرفي
 * النشط ضمن نطاق المناطق (getScopedSurveyDoctors في surveyDoctors.js)، وتُلحق
 * بها الزيارات إن وُجدت (عبر masterSurveyDoctorId أو الاسم كبديل). فـDoctor
 * بلا ربط سيرفي (masterSurveyDoctorId=null) قد تُنشأ زيارته بنجاح في قاعدة
 * البيانات لكنها لن تظهر أبداً في تلك الشاشة. لذلك — تماماً كميزة «إضافة طبيب
 * جديد» الموجودة أصلاً (addCustomDoctor) — كل طبيب جديد هنا يُنشأ عبر السيرفي
 * أولاً (createSurveyDoctor) لا كصف Doctor مستقل.
 */
async function commitDoctorRows(rows, ownerUserId, user) {
  const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
  const areaByNorm = new Map(allAreas.map(a => [normalizeAreaName(a.name), a]));

  // نفس السيرفي المضيف الذي تستعمله addCustomDoctor — أول سيرفي نشط ظاهر لهذا المالك.
  const hostSurvey = await prisma.masterSurvey.findFirst({
    where: {
      isActive: true,
      hiddenUsers: { none: { userId: ownerUserId } },
      ...(user?.officeId ? { hiddenOffices: { none: { officeId: user.officeId } } } : {}),
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  // أطباء السيرفي المتاحون لهذا المالك — لمطابقة طبيب موجود أصلاً بدل تكراره
  // كسجل سيرفي جديد منفصل بنفس الاسم.
  const visibleSurveys = await prisma.masterSurvey.findMany({
    where: { isActive: true, hiddenUsers: { none: { userId: ownerUserId } } },
    select: { id: true },
  });
  const surveyDoctorsAll = visibleSurveys.length
    ? await prisma.masterSurveyDoctor.findMany({
        where: { surveyId: { in: visibleSurveys.map(s => s.id) } },
        select: { id: true, name: true, areaName: true },
      })
    : [];
  const findSurveyDoctor = (name, areaNameLocal) => {
    const nameNorm = name.trim().toLowerCase();
    const cands = surveyDoctorsAll.filter(d => d.name.trim().toLowerCase() === nameNorm);
    if (cands.length === 0) return null;
    if (cands.length === 1) return cands[0];
    const areaN = normalizeAreaName(areaNameLocal || '');
    return cands.find(d => normalizeAreaName(d.areaName ?? '') === areaN) ?? cands[0];
  };

  // Doctor الموجودون أصلاً تحت هذا المالك — لتفادي إنشاء طبيب مكرّر لصف لاحق بنفس الاسم.
  const existingDoctors = await prisma.doctor.findMany({
    where: { userId: ownerUserId },
    select: { id: true, name: true, areaId: true, masterSurveyDoctorId: true },
  });
  const findExistingDoctor = (name, areaIdLocal) => {
    const nameNorm = name.trim().toLowerCase();
    const cands = existingDoctors.filter(d => d.name.trim().toLowerCase() === nameNorm);
    if (cands.length === 0) return null;
    if (areaIdLocal) return cands.find(d => d.areaId === areaIdLocal) ?? cands[0];
    return cands[0];
  };

  let imported = 0, skipped = 0;
  const errors = [];
  const doctorCache = new Map(); // "الاسم|areaId" → doctorId (يمنع تكرار الإنشاء لنفس الطبيب عبر صفوف الملف)
  let unlinkedNote = false;

  for (const r of (Array.isArray(rows) ? rows : [])) {
    try {
      const doctorName = String(r?.doctorName ?? '').trim();
      if (!doctorName) { skipped++; continue; }
      if (!r?.repId) { skipped++; errors.push(`طبيب — صف ${r?._row ?? '?'}: بلا مندوب مؤكَّد (${r?.repName || doctorName})`); continue; }

      let areaId = r.areaId ?? null;
      const areaName = String(r?.areaName ?? '').trim();
      if (!areaId && areaName) {
        const norm = normalizeAreaName(areaName);
        let found = areaByNorm.get(norm);
        if (!found) {
          found = await prisma.area.create({ data: { name: areaName, userId: ownerUserId } });
          areaByNorm.set(normalizeAreaName(found.name), found);
        }
        areaId = found.id;
      }

      let doctorId = r.doctorId ?? null;
      const cacheKey = `${doctorName.toLowerCase()}|${areaId ?? ''}`;
      if (!doctorId) doctorId = doctorCache.get(cacheKey) ?? null;

      if (!doctorId) {
        const matchedDoctor = findExistingDoctor(doctorName, areaId);

        if (matchedDoctor) {
          doctorId = matchedDoctor.id;
          // موجود لكن غير مربوط بأي سيرفي بعد — اربطه بدل تركه يتيماً (لن يظهر
          // في شاشة الزيارات بلا هذا الربط).
          if (!matchedDoctor.masterSurveyDoctorId) {
            const sd = findSurveyDoctor(doctorName, areaName) ?? (hostSurvey
              ? await createSurveyDoctor(hostSurvey.id, {
                  name: doctorName, specialty: r.specialty || null,
                  areaName: areaName || null, pharmacyName: r.pharmacyName || null,
                }, ownerUserId)
              : null);
            if (sd) {
              await prisma.doctor.update({ where: { id: doctorId }, data: { masterSurveyDoctorId: sd.id } });
              matchedDoctor.masterSurveyDoctorId = sd.id;
            } else {
              unlinkedNote = true;
            }
          }
        } else {
          // طبيب جديد بالكامل — يُنشأ عبر السيرفي أولاً كي يظهر في الزيارات/
          // الأطباء/الأرشيف، ثم صف Doctor المربوط به (نفس نمط addCustomDoctor).
          const sd = findSurveyDoctor(doctorName, areaName) ?? (hostSurvey
            ? await createSurveyDoctor(hostSurvey.id, {
                name: doctorName, specialty: r.specialty || null,
                areaName: areaName || null, pharmacyName: r.pharmacyName || null,
              }, ownerUserId)
            : null);
          if (!sd) unlinkedNote = true;

          const created = await prisma.doctor.create({
            data: {
              name: doctorName,
              specialty: r.specialty || null,
              pharmacyName: r.pharmacyName || null,
              areaId,
              userId: ownerUserId,
              masterSurveyDoctorId: sd?.id ?? null,
            },
          });
          doctorId = created.id;
          existingDoctors.push({ id: created.id, name: doctorName, areaId, masterSurveyDoctorId: sd?.id ?? null });
          if (sd) surveyDoctorsAll.push({ id: sd.id, name: doctorName, areaName });
        }
        doctorCache.set(cacheKey, doctorId);
      } else if (r.specialty || r.pharmacyName || areaId) {
        const doc = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { specialty: true, pharmacyName: true, areaId: true } });
        if (doc) {
          const upd = {};
          if (!doc.specialty    && r.specialty)    upd.specialty    = r.specialty;
          if (!doc.pharmacyName && r.pharmacyName) upd.pharmacyName = r.pharmacyName;
          if (!doc.areaId       && areaId)         upd.areaId       = areaId;
          if (Object.keys(upd).length) await prisma.doctor.update({ where: { id: doctorId }, data: upd });
        }
      }

      const dateVal = parseVisitDate(r.date);
      await prisma.doctorVisit.create({
        data: {
          doctorId,
          scientificRepId: r.repId,
          visitDate: dateVal ?? new Date(),
          itemId: r.itemId ?? null,
          feedback: r.feedback || 'pending',
          notes: r.notes ? String(r.notes) : null,
          isDoubleVisit: !!r.isDoubleVisit,
          latitude:  Number.isFinite(r.lat) ? r.lat : null,
          longitude: Number.isFinite(r.lng) ? r.lng : null,
          userId: user.id,
        },
      });
      imported++;
    } catch (e) {
      skipped++;
      errors.push(`طبيب — صف ${r?._row ?? '?'}: ${e.message}`);
    }
  }

  if (unlinkedNote) {
    errors.push('تنبيه: لا توجد قائمة سيرفي متاحة لهذا الحساب — بعض الأطباء الجدد أُنشئوا بلا ربط بالسيرفي ولن يظهروا في شاشة «الزيارات» حتى تُربط لاحقاً.');
  }

  return { imported, skipped, errors };
}

/** نفس منطق commitDoctorRows لكن لِـ PharmacyVisit — pharmacyName نص حر بلا سجل رئيسي فيُحفظ كما هو. */
async function commitPharmacyRows(rows, ownerUserId, user) {
  const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
  const areaByNorm = new Map(allAreas.map(a => [normalizeAreaName(a.name), a]));

  let imported = 0, skipped = 0;
  const errors = [];

  for (const r of (Array.isArray(rows) ? rows : [])) {
    try {
      const pharmacyName = String(r?.pharmacyName ?? '').trim();
      if (!pharmacyName) { skipped++; continue; }
      if (!r?.repId) { skipped++; errors.push(`صيدلية — صف ${r?._row ?? '?'}: بلا مندوب مؤكَّد (${r?.repName || pharmacyName})`); continue; }

      let areaId = r.areaId ?? null;
      const areaName = String(r?.areaName ?? '').trim();
      if (!areaId && areaName) {
        const norm = normalizeAreaName(areaName);
        let found = areaByNorm.get(norm);
        if (!found) {
          found = await prisma.area.create({ data: { name: areaName, userId: ownerUserId } });
          areaByNorm.set(normalizeAreaName(found.name), found);
        }
        areaId = found.id;
      }

      const dateVal = parseVisitDate(r.date);
      await prisma.pharmacyVisit.create({
        data: {
          pharmacyName,
          areaId,
          areaName: areaId ? null : (areaName || null),
          scientificRepId: r.repId,
          visitDate: dateVal ?? new Date(),
          notes: r.notes ? String(r.notes) : null,
          isDoubleVisit: !!r.isDoubleVisit,
          latitude:  Number.isFinite(r.lat) ? r.lat : null,
          longitude: Number.isFinite(r.lng) ? r.lng : null,
          userId: user.id,
        },
      });
      imported++;
    } catch (e) {
      skipped++;
      errors.push(`صيدلية — صف ${r?._row ?? '?'}: ${e.message}`);
    }
  }

  return { imported, skipped, errors };
}

/**
 * نقطة الحفظ الموحّدة: تحفظ روابط أسماء المندوبين المؤكَّدة أولاً (تُستعمل
 * فوراً + تُطبَّق تلقائياً في ميركاتو والاستيرادات القادمة)، ثم تستورد صفوف
 * الأطباء والصيدليات معاً (أي منهما قد يكون فارغاً حسب صيغة الملف).
 */
export async function commitVisitsImport({ doctorRows = [], pharmacyRows = [], rememberRepLinks = [], user }) {
  const ownerUserId = await resolveDocOwnerUserId(user.id);

  if (rememberRepLinks.length) await saveRepNameLinks(user.id, rememberRepLinks);

  const [doctorResult, pharmacyResult] = await Promise.all([
    commitDoctorRows(doctorRows, ownerUserId, user),
    commitPharmacyRows(pharmacyRows, ownerUserId, user),
  ]);

  return {
    imported: doctorResult.imported + pharmacyResult.imported,
    skipped:  doctorResult.skipped + pharmacyResult.skipped,
    errors:   [...doctorResult.errors, ...pharmacyResult.errors].slice(0, 30),
    doctor:   doctorResult,
    pharmacy: pharmacyResult,
  };
}
