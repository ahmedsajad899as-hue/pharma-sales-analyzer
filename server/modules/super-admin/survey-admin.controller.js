import prisma from '../../lib/prisma.js';
import { createSurveyDoctor, updateSurveyDoctor as updateSurveyDoctorLib, deactivateSurveyDoctor, reactivateSurveyDoctor, classifySurveyDoctorRows, saveSurveyDoctorAlias, ensureGlobalArea, loadAreaNameIndex, resolveAreaScope } from '../../lib/surveyDoctors.js';
import { createSurveyPharmacy, updateSurveyPharmacy as updateSurveyPharmacyLib, deactivateSurveyPharmacy, reactivateSurveyPharmacy, mergeSurveyPharmacies, findPharmacyMergeSuggestions, previewPharmacyNameCleanup, applyPharmacyNameCleanup, pharmacyDedupKey } from '../../lib/surveyPharmacies.js';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import { areaIdsOfProvinces, areaIdsOfSubProvinces } from '../../lib/areaScope.js';

// ── مَن قام بالتعديل (editedById) ─────────────────────────────
// MasterSurveyEditLog.editedById و lastEditedById كلاهما مفتاح أجنبي إلى **User**
// لا إلى SuperAdmin. تمرير req.superAdmin.id هنا كان يعني أحد أمرين، كلاهما خطأ:
// نسبة التعديل لمستخدم عشوائي يصادف أن رقمه مطابق، أو خرق قيد المفتاح الأجنبي.
// والاصطلاح المعتمد في كل مكتبات السيرفي صريح: null = السوبر أدمن. تغذية 🔔
// «سجل الأطباء» تعتمد عليه حرفياً (editedById != null تعني «مندوب غيّر هذا»)،
// فأي قيمة غير null هنا كانت تُظهر تعديلات السوبر أدمن كأنها تعديلات مندوبين.
const SA_EDITOR = null;

// ── Survey CRUD ──────────────────────────────────────────────
export async function listSurveys(req, res, next) {
  try {
    const surveys = await prisma.masterSurvey.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { doctors: { where: { isActive: true } }, pharmacies: { where: { isActive: true } } } },
        createdBy: { select: { username: true, displayName: true } },
      },
    });
    res.json({ success: true, data: surveys });
  } catch (e) { next(e); }
}

export async function getSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    // المعطَّلون مُستبعَدون افتراضياً حتى في لوحة السوبر أدمن كي يطابق العدد ما
    // يراه المستخدمون؛ ?includeInactive=1 يُظهرهم لمراجعتهم أو إرجاعهم.
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const rowFilter = includeInactive ? {} : { where: { isActive: true } };
    const survey = await prisma.masterSurvey.findUnique({
      where: { id },
      include: {
        doctors:    { ...rowFilter, orderBy: { createdAt: 'asc' }, include: { lastEditedBy: { select: { username: true, displayName: true } } } },
        pharmacies: { ...rowFilter, orderBy: { createdAt: 'asc' }, include: { lastEditedBy: { select: { username: true, displayName: true } } } },
        _count: { select: { hiddenUsers: true, hiddenOffices: true, drugEntries: true } },
      },
    });
    if (!survey) return res.status(404).json({ success: false, error: 'لم يُعثر على السيرفي' });
    res.json({ success: true, data: survey });
  } catch (e) { next(e); }
}

export async function createSurvey(req, res, next) {
  try {
    const { name, description, isActive, surveyType } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'الاسم مطلوب' });
    const survey = await prisma.masterSurvey.create({
      data: {
        name: name.trim(),
        description: description?.trim() ?? null,
        isActive: isActive !== false,
        surveyType: surveyType === 'drug_prices' ? 'drug_prices' : 'general',
        createdById: req.superAdmin?.id ?? null, // هذا الحقل فعلاً مفتاح إلى SuperAdmin
      },
    });
    res.status(201).json({ success: true, data: survey });
  } catch (e) { next(e); }
}

export async function updateSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    const { name, description, isActive, surveyType } = req.body;
    const data = {};
    if (name       !== undefined) data.name        = name.trim();
    if (description !== undefined) data.description = description?.trim() ?? null;
    if (isActive   !== undefined) data.isActive    = !!isActive;
    if (surveyType !== undefined) data.surveyType  = surveyType === 'drug_prices' ? 'drug_prices' : 'general';
    const survey = await prisma.masterSurvey.update({ where: { id }, data });
    res.json({ success: true, data: survey });
  } catch (e) { next(e); }
}

export async function deleteSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    await prisma.masterSurvey.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Survey Doctors ───────────────────────────────────────────
// كل العمليات تمرّ عبر server/lib/surveyDoctors.js. كانت هذه الدوال تحمل نسخة
// ثانية من منطق الإنشاء/التعديل/الـ cascade/السجل (ونسخة ثالثة في
// master-survey.controller.js) وتباعدت النسخ فعلاً: نسخة السوبر أدمن لم تكن
// تضبط lastEditedById إطلاقاً. المكتبة هي المصدر الوحيد الآن.
export async function addDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { name, specialty, areaName, pharmacyName, className, zoneName, phone, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الطبيب مطلوب' });
    const doc = await createSurveyDoctor(surveyId, { name, specialty, areaName, pharmacyName, className, zoneName, phone, notes }, SA_EDITOR);
    res.status(201).json({ success: true, data: doc });
  } catch (e) { next(e); }
}

export async function updateDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const docId    = parseInt(req.params.docId);
    const { name, specialty, areaName, pharmacyName, className, zoneName, phone, notes } = req.body;
    const result = await updateSurveyDoctorLib(surveyId, docId, { name, specialty, areaName, pharmacyName, className, zoneName, phone, notes }, SA_EDITOR);
    if (result.error) return res.status(404).json({ success: false, error: 'غير موجود' });
    res.json({ success: true, data: result.updated });
  } catch (e) { next(e); }
}

// حذف = تعطيل. راجع deactivateSurveyDoctor: الحذف الفعلي كان يمحو معه كل
// MasterSurveyDoctorAlias المرتبطة بالطبيب (ذاكرة المطابقة المتراكمة) ويفصل
// تاريخ الزيارات عن مصدره. الصف المعطَّل يظهر في اللوحة عبر includeInactive
// ويُرجَع بضغطة من المسار أدناه.
export async function deleteDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const docId    = parseInt(req.params.docId);
    const result = await deactivateSurveyDoctor(surveyId, docId, SA_EDITOR);
    if (result.error) return res.status(404).json({ success: false, error: 'غير موجود' });
    res.json({ success: true, deactivated: true, affectedDoctorRows: result.affectedDoctorRows ?? 0 });
  } catch (e) { next(e); }
}

export async function restoreDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const docId    = parseInt(req.params.docId);
    const result = await reactivateSurveyDoctor(surveyId, docId, SA_EDITOR);
    if (result.error) return res.status(404).json({ success: false, error: 'غير موجود' });
    res.json({ success: true, data: result.updated });
  } catch (e) { next(e); }
}

// ── استيراد أطباء السيرفي بمطابقة (لا إدراج أعمى) ──────────────────────────
// تدفّق على مرحلتين (مطابق لنمط doctor-visits-import.js):
//   1) extractDoctorImport — يصنّف كل صف مقابل أطباء هذا السيرفي + الروابط
//      المحفوظة (MasterSurveyDoctorAlias)، بلا أي كتابة — للمراجعة فقط.
//   2) commitDoctorImport — يستقبل الصفوف بعد قرار السوبر أدمن على كل حالة
//      "ask"، وينشئ/يحدّث فعلياً.
export async function extractDoctorImport(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { doctors } = req.body;
    if (!Array.isArray(doctors) || doctors.length === 0)
      return res.status(400).json({ success: false, error: 'لا يوجد بيانات' });
    const classification = await classifySurveyDoctorRows(surveyId, doctors);
    // classifySurveyDoctorRows تُلصق rowKey/matchedDoctorId داخل عناصر doctors
    // نفسها (بالمرجع) — تُعاد هنا كي تستبدل الواجهة نسختها الخام بها، فتحمل كل
    // صفوف "resolved"/"unrelated" مطابقتها المحسومة جاهزة بلا إعادة حساب المفتاح محلياً.
    res.json({ success: true, data: { ...classification, rows: doctors } });
  } catch (e) { console.error('[extractDoctorImport]', e.message, e.code); next(e); }
}

export async function commitDoctorImport(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ success: false, error: 'لا يوجد بيانات' });

    const editedById = SA_EDITOR;
    const areaCache = await loadAreaNameIndex();
    let created = 0, matched = 0;

    for (const r of rows) {
      const name = String(r?.name ?? '').trim();
      if (!name) continue;
      const fields = {
        specialty:    r.specialty    || null,
        areaName:     r.areaName     || null,
        pharmacyName: r.pharmacyName || null,
        className:    r.className    || null,
        zoneName:     r.zoneName     || null,
        phone:        r.phone        || null,
        notes:        r.notes        || null,
      };

      if (r.matchedDoctorId) {
        // صف مطابق لطبيب موجود: عبّئ الحقول الفارغة فقط من الملف — لا يستبدل
        // أي قيمة موجودة أصلاً في السيرفي (البيانات المُثبَّتة يدوياً مرجع).
        const existing = await prisma.masterSurveyDoctor.findUnique({ where: { id: r.matchedDoctorId } });
        if (existing && existing.surveyId === surveyId) {
          const fillData = {};
          for (const [k, v] of Object.entries(fields)) {
            if (v && !existing[k]) fillData[k] = v;
          }
          if (Object.keys(fillData).length) {
            await updateSurveyDoctorLib(surveyId, existing.id, fillData, editedById, areaCache);
          }
          // حالة "ask" حسمها السوبر أدمن يدوياً — تُحفظ كي لا يُعاد السؤال عن
          // نفس هذا الاسم لاحقاً (سواء في استيراد سيرفي آخر أو استيراد زيارات).
          if (r.wasAsk) {
            await saveSurveyDoctorAlias(surveyId, {
              fromName: name, areaName: r.areaName, surveyDoctorId: existing.id,
              confidence: 'confirmed', createdById: editedById,
            });
          }
          matched++;
          continue;
        }
      }

      // لا تطابق — طبيب سيرفي جديد
      const doc = await createSurveyDoctor(surveyId, { name, ...fields }, editedById, areaCache);
      if (r.wasAsk) {
        await saveSurveyDoctorAlias(surveyId, {
          fromName: name, areaName: r.areaName, surveyDoctorId: doc.id,
          confidence: 'confirmed', createdById: editedById,
        });
      }
      created++;
    }

    res.status(201).json({ success: true, created, matched });
  } catch (e) { console.error('[commitDoctorImport]', e.message, e.code); next(e); }
}

// ── فحص ظهور أطباء السيرفي ────────────────────────────────────
// عدد الأطباء في لوحة السوبر أدمن هو العدد الخام لكل صفوف السيرفي، بينما ما
// يراه أي مستخدم يمرّ بفلتر getScopedSurveyDoctors: «اسم منطقة غير فارغ +
// مطابق (بعد التطبيع) لإحدى مناطق نطاقه». الفرق بين الرقمين كان يظهر كأنه عطل
// بلا أي وسيلة لمعرفة أي أطباء سقطوا ولا لماذا. هذه الدالة تُصنّف كل طبيب إلى
// سبب واحد محدَّد، مجمَّعاً باسم المنطقة كي يكون قابلاً للإصلاح مباشرة.
export async function coverageCheck(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const userId   = req.query.userId ? parseInt(req.query.userId) : null;

    const [docs, areas, users] = await Promise.all([
      prisma.masterSurveyDoctor.findMany({
        where:  { surveyId },
        select: { id: true, name: true, areaName: true, isActive: true },
      }),
      prisma.area.findMany({ select: { id: true, name: true } }),
      prisma.user.findMany({
        select:  { id: true, username: true, displayName: true, role: true },
        orderBy: { displayName: 'asc' },
      }),
    ]);

    // كتالوج المناطق: الاسم المطبَّع → معرّفات الصفوف (نفس تطبيع المطابقة الحقيقي)
    const catalogIds = new Map();
    for (const a of areas) {
      const n = normalizeAreaName(a.name);
      if (!catalogIds.has(n)) catalogIds.set(n, []);
      catalogIds.get(n).push(a.id);
    }

    // اتحاد نطاقات كل المستخدمين — منطقة خارجه = لا يراها أحد إطلاقاً
    const [ua, sra, upa, uspa] = await Promise.all([
      prisma.userAreaAssignment.findMany({ select: { areaId: true } }),
      prisma.scientificRepArea.findMany({ select: { areaId: true } }),
      prisma.userProvinceAssignment.findMany({ select: { provinceId: true } }),
      prisma.userSubProvinceAssignment.findMany({ select: { subProvinceId: true } }),
    ]);
    const [provAreaIds, subAreaIds] = await Promise.all([
      areaIdsOfProvinces([...new Set(upa.map(r => r.provinceId))]),
      areaIdsOfSubProvinces([...new Set(uspa.map(r => r.subProvinceId))]),
    ]);
    const assignedAreaIds = new Set([
      ...ua.map(r => r.areaId), ...sra.map(r => r.areaId), ...provAreaIds, ...subAreaIds,
    ]);

    // نطاق مستخدم بعينه — يُحسب بنفس resolveAreaScope الذي تستعمله الشاشات
    let target = null;
    if (userId) {
      const u = users.find(x => x.id === userId);
      if (u) {
        const scope = await resolveAreaScope({ id: u.id, role: u.role }, {});
        target = { user: u, normAreas: new Set(scope.normAreaNames) };
      }
    }

    const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
    const deactivated = [];            // معطَّل — مخفي عمداً، ليس عطل ظهور
    const noArea = [];                 // بلا اسم منطقة أصلاً — لا يراه أحد
    const notInCatalog   = new Map();  // اسم منطقة بلا صف Area مطابق
    const unassignedAll  = new Map();  // المنطقة موجودة لكن غير مُسندة لأي مستخدم
    const outOfTargetScope = new Map();// مُسندة لغيره لكنها خارج نطاق المستخدم المحدَّد
    let visibleToTarget = 0, visibleToSomeone = 0;

    for (const d of docs) {
      // المعطَّل يُصنَّف أولاً: بدونه يظهر ضمن أحد أسباب «لا يراه أحد» فيبدو
      // عطلاً في الظهور بينما هو إخفاء مقصود قابل للإرجاع.
      if (!d.isActive) { deactivated.push({ id: d.id, name: d.name, areaName: d.areaName ?? null }); continue; }
      const raw = d.areaName?.trim();
      if (!raw) { noArea.push({ id: d.id, name: d.name }); continue; }
      const norm = normalizeAreaName(raw);
      const ids  = catalogIds.get(norm);
      if (!ids?.length) { bump(notInCatalog, raw); continue; }
      if (!ids.some(id => assignedAreaIds.has(id))) { bump(unassignedAll, raw); continue; }
      visibleToSomeone++;
      if (target) {
        if (target.normAreas.has(norm)) visibleToTarget++;
        else bump(outOfTargetScope, raw);
      }
    }

    const toList = map => [...map.entries()]
      .map(([areaName, count]) => ({ areaName, count }))
      .sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      data: {
        total: docs.length,
        active: docs.length - deactivated.length,
        visibleToSomeone,
        deactivated: { count: deactivated.length, sample: deactivated.slice(0, 50) },
        noArea: { count: noArea.length, sample: noArea.slice(0, 50) },
        notInCatalog:  toList(notInCatalog),
        unassignedAll: toList(unassignedAll),
        target: target ? {
          userId: target.user.id,
          name:   target.user.displayName || target.user.username,
          role:   target.user.role,
          visible: visibleToTarget,
          outOfScope: toList(outOfTargetScope),
        } : null,
        users: users.map(u => ({ id: u.id, name: u.displayName || u.username, role: u.role })),
      },
    });
  } catch (e) { next(e); }
}

// ── Survey Pharmacies ────────────────────────────────────────
// addPharmacy/updatePharmacy/deletePharmacy/mergePharmacies تُفوَّض لمكتبة
// surveyPharmacies.js المشتركة (نفس نمط أطباء السيرفي في surveyDoctors.js):
// ensureGlobalArea يضمن ظهور صيدلية بمنطقة جديدة كلياً لكل الفرق فوراً، وتعديل/
// حذف/دمج الاسم يُطبَّق تلقائياً على الأطباء المرتبطين وزيارات الصيدليات
// المسجَّلة بالاسم القديم — فيتطابق ما يظهر عند جميع المستخدمين في صفحة
// السيرفي وتحليل الزيارات مباشرة مع لوحة السوبر أدمن، بلا أي انتظار.
export async function addPharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { name, ownerName, pharmacyName, phone, address, areaName, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الصيدلية مطلوب' });
    const ph = await createSurveyPharmacy(surveyId, { name, ownerName, pharmacyName, phone, address, areaName, notes }, SA_EDITOR);
    const { _duplicate, ...data } = ph;
    res.status(_duplicate ? 200 : 201).json({ success: true, data, duplicate: !!_duplicate });
  } catch (e) { next(e); }
}

export async function updatePharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const pharmaId = parseInt(req.params.pharmaId);
    const { name, ownerName, pharmacyName, phone, address, areaName, notes } = req.body;
    const result = await updateSurveyPharmacyLib(surveyId, pharmaId, { name, ownerName, pharmacyName, phone, address, areaName, notes }, SA_EDITOR);
    if (result.error) return res.status(404).json({ success: false, error: 'غير موجود' });
    res.json({ success: true, data: result.updated });
  } catch (e) { next(e); }
}

// حذف = تعطيل. الحذف الفعلي (deleteSurveyPharmacy) كان يُخمّن «أقرب اسم بديل»
// بين الصيدليات المتبقية وينقل إليه أطباء الصيدلية المحذوفة وزياراتها — تخمين
// لا رجعة فيه على بيانات ميدانية. التعطيل لا يلمس أي اسم.
export async function deletePharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const pharmaId = parseInt(req.params.pharmaId);
    const result = await deactivateSurveyPharmacy(surveyId, pharmaId, SA_EDITOR);
    if (result.error) return res.status(404).json({ success: false, error: 'غير موجود' });
    res.json({ success: true, deactivated: true });
  } catch (e) { next(e); }
}

export async function restorePharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const pharmaId = parseInt(req.params.pharmaId);
    const result = await reactivateSurveyPharmacy(surveyId, pharmaId, SA_EDITOR);
    if (result.error) return res.status(404).json({ success: false, error: 'غير موجود' });
    res.json({ success: true, data: result.updated });
  } catch (e) { next(e); }
}

// ── دمج صيدليات (اثنتان أو أكثر) في صيدلية واحدة ──────────────
// يُبقي على اسم keepId ويحذف كل صيدليات mergeIds، وينقل كل الأطباء الذين كان
// اسم صيدليتهم هو اسم إحدى الصيدليات المدموجة إلى اسم الصيدلية الباقية (في
// MasterSurveyDoctor وفي كل صفوف Doctor المرتبطة بها عبر masterSurveyDoctorId
// — نفس نمط cascade المستخدم عند تعديل اسم صيدلية طبيب واحد).
// body: { keepId, mergeIds: number[] } — mergeId مفرد (توافقاً مع النسخة السابقة) مقبول أيضاً.
export async function mergePharmacies(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const keepId = parseInt(req.body?.keepId);
    const rawMergeIds = Array.isArray(req.body?.mergeIds)
      ? req.body.mergeIds
      : (req.body?.mergeId != null ? [req.body.mergeId] : []);
    const mergeIds = [...new Set(rawMergeIds.map(id => parseInt(id)).filter(id => id && id !== keepId))];
    if (!keepId || mergeIds.length === 0)
      return res.status(400).json({ success: false, error: 'اختر صيدلية للإبقاء عليها وصيدلية واحدة على الأقل لدمجها' });

    const result = await mergeSurveyPharmacies(surveyId, keepId, mergeIds, SA_EDITOR);
    if (result.error) return res.status(404).json({ success: false, error: 'غير موجود' });
    res.json({ success: true, reassignedDoctors: result.reassignedDoctors, mergedCount: result.mergedCount, data: result.data });
  } catch (e) { next(e); }
}

// ── اقتراحات دمج ذكية ──────────────────────────────────────────
// يجمّع صيدليات هذا السيرفي في مجموعات "يُحتمل أنها نفس الصيدلية بأسماء مختلفة
// قليلاً" — يوفّر على السوبر أدمن البحث اليدوي بين آلاف الأسماء لإيجاد
// مرشّحي الدمج (انظر findPharmacyMergeSuggestions). قراءة فقط.
export async function getPharmacyMergeSuggestions(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const [pharmacies, docsWithPharma] = await Promise.all([
      prisma.masterSurveyPharmacy.findMany({
        where: { surveyId, isActive: true },
        select: { id: true, name: true, areaName: true, ownerName: true, phone: true },
      }),
      prisma.masterSurveyDoctor.findMany({
        where: { surveyId, pharmacyName: { not: null }, isActive: true },
        select: { pharmacyName: true },
      }),
    ]);
    const cmpKey = s => String(s ?? '').trim().toLowerCase();
    const doctorCountByKey = new Map();
    for (const d of docsWithPharma) {
      const k = cmpKey(d.pharmacyName);
      doctorCountByKey.set(k, (doctorCountByKey.get(k) ?? 0) + 1);
    }
    const suggestions = findPharmacyMergeSuggestions(pharmacies, doctorCountByKey);

    // ── دمج تلقائي فوري بالخلفية للمجموعات المتطابقة 100% (اسم + منطقة معاً) ──
    // هذي الحالة الوحيدة بلا أي قرار بشري مطلوب: نفس الصف حرفياً مكرر من كل
    // الجوانب، فدمجه لا يفقد أي معلومة (لا منطقة ولا شيء آخر). المجموعات اللي
    // الاسم فقط متطابق لكن المنطقة تختلف (قد تكون فرعين حقيقيين، أو خطأ إدخال)
    // تبقى تحتاج مراجعة يدوية في الواجهة كما هي الآن.
    const remaining = [];
    let autoMerged = 0;
    for (const g of suggestions) {
      const anchor = g.members.find(m => m.id === g.suggestedKeepId);
      const anchorKey = anchor ? pharmacyDedupKey(anchor.name, anchor.areaName) : null;
      const fullyExact = anchorKey && g.members.every(m => pharmacyDedupKey(m.name, m.areaName) === anchorKey);
      if (fullyExact) {
        const mergeIds = g.members.filter(m => m.id !== g.suggestedKeepId).map(m => m.id);
        if (mergeIds.length) {
          await mergeSurveyPharmacies(surveyId, g.suggestedKeepId, mergeIds, SA_EDITOR);
          autoMerged++;
        }
      } else {
        remaining.push(g);
      }
    }
    res.json({ success: true, data: remaining, autoMerged });
  } catch (e) { next(e); }
}

// ── تنظيف أسماء الصيدليات (إزالة بادئة "ص/صيدلية/الاسم/العميل" + توحيد ه↔ة) ──
// معاينة بلا كتابة، ثم تطبيق فعلي على الأسماء المحدَّدة فقط (checkboxes في
// الواجهة) — نفس منطق normalizePharmacyStoredName في surveyPharmacies.js.
export async function previewPharmacyNameCleanupCtrl(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const changes = await previewPharmacyNameCleanup(surveyId);
    res.json({ success: true, data: changes });
  } catch (e) { next(e); }
}

export async function applyPharmacyNameCleanupCtrl(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'اختر اسماً واحداً على الأقل' });
    const result = await applyPharmacyNameCleanup(surveyId, ids, SA_EDITOR);
    res.json({ success: true, ...result });
  } catch (e) { next(e); }
}

export async function bulkImportPharmacies(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { pharmacies } = req.body;
    if (!Array.isArray(pharmacies) || pharmacies.length === 0)
      return res.status(400).json({ success: false, error: 'لا يوجد بيانات' });
    // ensureGlobalArea لكل منطقة جديدة في الملف — بدون هذا، صيدلية بمنطقة لم
    // تُستخدم من قبل تبقى غير مرئية لأي مستخدم للأبد (نفس فخ استيراد الأطباء).
    const areaCache = await loadAreaNameIndex();
    for (const p of pharmacies) {
      if (p.areaName?.trim()) await ensureGlobalArea(p.areaName, areaCache);
    }
    // منع تكرار حرفي: صف بنفس الاسم+المنطقة (بعد التطبيع) موجود مسبقاً في هذا
    // السيرفي — أو مكرَّر داخل نفس دفعة الاستيراد — يُستبعد بدل إدراج نسخة
    // جديدة. يسمح بإعادة استيراد نفس ملف السيرفي بأمان دون تكديس صفوف متطابقة
    // (راجع اقتراحات الدمج الذكي — هذا هو مصدرها الأساسي).
    const existingRows = await prisma.masterSurveyPharmacy.findMany({
      where: { surveyId }, select: { name: true, areaName: true },
    });
    const seenKeys = new Set(existingRows.map(p => pharmacyDedupKey(p.name, p.areaName)));
    let skipped = 0;
    const data = [];
    for (const p of pharmacies) {
      if (!p.name?.trim()) continue;
      const key = pharmacyDedupKey(p.name, p.areaName);
      if (seenKeys.has(key)) { skipped++; continue; }
      seenKeys.add(key);
      data.push({
        surveyId,
        name:         p.name.trim(),
        ownerName:    p.ownerName    || null,
        pharmacyName: p.pharmacyName || null,
        phone:        p.phone        || null,
        address:      p.address      || null,
        areaName:     p.areaName     || null,
        notes:        p.notes        || null,
      });
    }
    const result = data.length ? await prisma.masterSurveyPharmacy.createMany({ data }) : { count: 0 };
    res.status(201).json({ success: true, count: result.count, skipped });
  } catch (e) { next(e); }
}

// ── Visibility Management ────────────────────────────────────
export async function getVisibility(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const [users, offices, hiddenUsers, hiddenOffices] = await Promise.all([
      prisma.user.findMany({ select: { id: true, username: true, displayName: true, role: true, officeId: true }, orderBy: { displayName: 'asc' } }),
      prisma.scientificOffice.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.masterSurveyHiddenUser.findMany({ where: { surveyId }, select: { userId: true } }),
      prisma.masterSurveyHiddenOffice.findMany({ where: { surveyId }, select: { officeId: true } }),
    ]);
    const hiddenUserIds   = new Set(hiddenUsers.map(h => h.userId));
    const hiddenOfficeIds = new Set(hiddenOffices.map(h => h.officeId));
    res.json({
      success: true,
      data: {
        users:   users.map(u => ({ ...u, hidden: hiddenUserIds.has(u.id) })),
        offices: offices.map(o => ({ ...o, hidden: hiddenOfficeIds.has(o.id) })),
      },
    });
  } catch (e) { next(e); }
}

export async function hideUser(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const userId   = parseInt(req.params.userId);
    await prisma.masterSurveyHiddenUser.upsert({
      where: { surveyId_userId: { surveyId, userId } },
      create: { surveyId, userId },
      update: {},
    });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function showUser(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const userId   = parseInt(req.params.userId);
    await prisma.masterSurveyHiddenUser.deleteMany({ where: { surveyId, userId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function hideOffice(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const officeId = parseInt(req.params.officeId);
    await prisma.masterSurveyHiddenOffice.upsert({
      where: { surveyId_officeId: { surveyId, officeId } },
      create: { surveyId, officeId },
      update: {},
    });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function showOffice(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const officeId = parseInt(req.params.officeId);
    await prisma.masterSurveyHiddenOffice.deleteMany({ where: { surveyId, officeId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Audit Log ────────────────────────────────────────────────
export async function getSurveyLogs(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const page  = Math.max(1, parseInt(req.query.page  ?? '1'));
    const limit = Math.min(100, parseInt(req.query.limit ?? '50'));
    const skip  = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      prisma.masterSurveyEditLog.findMany({
        where: { surveyId },
        orderBy: { editedAt: 'desc' },
        skip, take: limit,
        include: { editedBy: { select: { id: true, username: true, displayName: true } } },
      }),
      prisma.masterSurveyEditLog.count({ where: { surveyId } }),
    ]);
    res.json({ success: true, data: logs, total, page, limit });
  } catch (e) { next(e); }
}

// ── Drug Price Survey Entries ─────────────────────────────────

export async function listDrugEntries(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const search = (req.query.search || '').trim();
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit || '100')));
    const skip  = (page - 1) * limit;
    const where = {
      surveyId,
      ...(search ? {
        OR: [
          { brandName:     { contains: search, mode: 'insensitive' } },
          { scientificName:{ contains: search, mode: 'insensitive' } },
          { company:       { contains: search, mode: 'insensitive' } },
          { dosageForm:    { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [entries, total] = await Promise.all([
      prisma.drugPriceSurveyEntry.findMany({
        where,
        orderBy: [{ brandName: 'asc' }, { company: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.drugPriceSurveyEntry.count({ where }),
    ]);
    res.json({ success: true, data: entries, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) { next(e); }
}

export async function addDrugEntry(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { brandName, scientificName, company, dosageForm, packaging, priceOfficeToWholesaler, priceWholesalerToPharmacy, pricePharmacyToPatient, notes } = req.body;
    if (!brandName?.trim()) return res.status(400).json({ success: false, error: '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u062a\u062c\u0627\u0631\u064a \u0645\u0637\u0644\u0648\u0628' });
    const entry = await prisma.drugPriceSurveyEntry.create({
      data: {
        surveyId,
        brandName: brandName.trim(),
        scientificName: scientificName?.trim() || null,
        company: company?.trim() || null,
        dosageForm: dosageForm?.trim() || null,
        packaging: packaging?.trim() || null,
        priceOfficeToWholesaler: priceOfficeToWholesaler != null ? Number(priceOfficeToWholesaler) : null,
        priceWholesalerToPharmacy: priceWholesalerToPharmacy != null ? Number(priceWholesalerToPharmacy) : null,
        pricePharmacyToPatient: pricePharmacyToPatient != null ? Number(pricePharmacyToPatient) : null,
        notes: notes?.trim() || null,
      },
    });
    res.status(201).json({ success: true, data: entry });
  } catch (e) { next(e); }
}

export async function updateDrugEntry(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const entryId  = parseInt(req.params.entryId);
    const old = await prisma.drugPriceSurveyEntry.findUnique({ where: { id: entryId } });
    if (!old || old.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    const { brandName, scientificName, company, dosageForm, packaging, priceOfficeToWholesaler, priceWholesalerToPharmacy, pricePharmacyToPatient, notes } = req.body;
    const data = {};
    if (brandName      !== undefined) data.brandName      = brandName.trim();
    if (scientificName !== undefined) data.scientificName = scientificName?.trim() || null;
    if (company        !== undefined) data.company        = company?.trim() || null;
    if (dosageForm     !== undefined) data.dosageForm     = dosageForm?.trim() || null;
    if (packaging      !== undefined) data.packaging      = packaging?.trim() || null;
    if (priceOfficeToWholesaler   !== undefined) data.priceOfficeToWholesaler   = priceOfficeToWholesaler   != null ? Number(priceOfficeToWholesaler)   : null;
    if (priceWholesalerToPharmacy !== undefined) data.priceWholesalerToPharmacy = priceWholesalerToPharmacy != null ? Number(priceWholesalerToPharmacy) : null;
    if (pricePharmacyToPatient    !== undefined) data.pricePharmacyToPatient    = pricePharmacyToPatient    != null ? Number(pricePharmacyToPatient)    : null;
    if (notes          !== undefined) data.notes          = notes?.trim() || null;
    const entry = await prisma.drugPriceSurveyEntry.update({ where: { id: entryId }, data });
    res.json({ success: true, data: entry });
  } catch (e) { next(e); }
}

export async function deleteDrugEntry(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const entryId  = parseInt(req.params.entryId);
    const entry = await prisma.drugPriceSurveyEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    await prisma.drugPriceSurveyEntry.delete({ where: { id: entryId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function bulkImportDrugEntries(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { entries, mode } = req.body;  // mode: 'insert' (default) | 'upsert' (update prices of existing entries)
    if (!Array.isArray(entries) || !entries.length)
      return res.status(400).json({ success: false, error: 'لا توجد بيانات' });
    const rows = entries
      .filter(e => e.brandName?.trim())
      .map(e => ({
        surveyId,
        brandName:     String(e.brandName).trim(),
        scientificName: e.scientificName?.trim() || null,
        company:        e.company?.trim() || null,
        dosageForm:     e.dosageForm?.trim() || null,
        packaging:      e.packaging?.trim() || null,
        priceOfficeToWholesaler:   e.priceOfficeToWholesaler   != null ? Number(e.priceOfficeToWholesaler)   : null,
        priceWholesalerToPharmacy: e.priceWholesalerToPharmacy != null ? Number(e.priceWholesalerToPharmacy) : null,
        pricePharmacyToPatient:    e.pricePharmacyToPatient    != null ? Number(e.pricePharmacyToPatient)    : null,
        notes:          e.notes?.trim() || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

    if (mode === 'upsert') {
      // Update prices on existing entries matched by brandName (case-insensitive) within same survey
      let updated = 0;
      for (const row of rows) {
        const result = await prisma.drugPriceSurveyEntry.updateMany({
          where: {
            surveyId,
            brandName: { equals: row.brandName, mode: 'insensitive' },
          },
          data: {
            ...(row.scientificName !== null ? { scientificName: row.scientificName } : {}),
            priceOfficeToWholesaler:   row.priceOfficeToWholesaler,
            priceWholesalerToPharmacy: row.priceWholesalerToPharmacy,
            pricePharmacyToPatient:    row.pricePharmacyToPatient,
            updatedAt: new Date(),
          },
        });
        updated += result.count;
      }
      return res.json({ success: true, count: updated, mode: 'upsert' });
    }

    await prisma.drugPriceSurveyEntry.createMany({ data: rows, skipDuplicates: false });
    res.json({ success: true, count: rows.length });
  } catch (e) { next(e); }
}
