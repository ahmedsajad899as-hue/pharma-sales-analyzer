import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import prisma from '../../lib/prisma.js';

// ── Constants ────────────────────────────────────────────────
const FEEDBACK_AR = {
  writing:        '\u0643\u0627\u062a\u0628 \u270d\ufe0f',
  stocked:        '\u0646\u0632\u0651\u0644 \ud83d\udce6',
  interested:     '\u0645\u0647\u062a\u0645 \ud83d\udc4d',
  not_interested: '\u063a\u064a\u0631 \u0645\u0647\u062a\u0645 \ud83d\udc4e',
  unavailable:    '\u063a\u064a\u0631 \u0645\u062a\u0648\u0641\u0631 \u274c',
  pending:        '\u0645\u0639\u0644\u0642 \u23f3',
};

// ── Fuzzy name matcher (Arabic-aware) ────────────────────────
const norm = s =>
  String(s ?? '').trim().toLowerCase()
    .replace(/[\u0623\u0625\u0622\u0627]/g, '\u0627')
    .replace(/[\u0629\u0647]/g, '\u0647')
    .replace(/[\u064a\u0649]/g, '\u064a')
    .replace(/\s+/g, ' ');

function fuzzyFind(list, key, query) {
  if (!query) return null;
  const q = norm(query);
  if (!q) return null;
  return (
    list.find(x => norm(x[key]) === q) ||
    list.find(x => norm(x[key]).startsWith(q) || q.startsWith(norm(x[key]))) ||
    list.find(x => norm(x[key]).includes(q) || q.includes(norm(x[key]))) ||
    null
  );
}

// ── Gemini system prompt ──────────────────────────────────────
function buildSystemPrompt({ currentPage, userRole, repNames, doctorNames, itemNames, areaNames, planNames }) {
  const now      = new Date();
  const curDay   = now.getDate();
  const curMonth = now.getMonth() + 1;
  const curYear  = now.getFullYear();

  const repsText  = repNames.length   ? repNames.join('، ')   : 'لا يوجد';
  const docsText  = doctorNames.length ? doctorNames.join('، ') : 'لا يوجد';
  const itemsText = itemNames.length  ? itemNames.join('، ')   : 'لا يوجد';
  const areasText = areaNames.length  ? areaNames.join('، ')   : 'لا يوجد';
  const plansText = planNames && planNames.length ? planNames.join('، ') : 'لا يوجد';

  return `أنت مساعد ذكي للتحكم الكامل في تطبيق مبيعات صيدلانية. مهمتك: تحليل أمر المستخدم وإرجاع query spec دقيق.

الصفحة الحالية: ${currentPage} | الدور: ${userRole}
التاريخ الآن: ${curDay}/${curMonth}/${curYear}

═══ مخطط قاعدة البيانات ═══
جدول DoctorVisit (زيارات الأطباء):
  • visitDate     — تاريخ الزيارة
  • feedback      — writing | stocked | interested | not_interested | unavailable | pending
  • notes         — ملاحظات
  • isDoubleVisit — زيارة مزدوجة (true/false)
  • doctor        — الطبيب (له name, specialty, area.name)
  • scientificRep — المندوب العلمي (له name)
  • item           — الإيتم/الدواء (له name)

جدول PharmacyVisit (زيارات الصيدليات):
  • visitDate     — تاريخ الزيارة
  • pharmacyName  — اسم الصيدلية
  • area          — المنطقة (لها name)
  • scientificRep — المندوب
  • items         — قائمة الأدوية المستخدمة
  • notes, isDoubleVisit

جدول Doctor (بيانات الأطباء):
  • name, specialty, area.name — كل طبيب مرتبط بمنطقة

═══ البيانات المتاحة ═══
المندوبون: ${repsText}
الأطباء: ${docsText}
الأيتمات: ${itemsText}
المناطق: ${areasText}
الخطط الشهرية (أسماء المندوبين): ${plansText}

═══ الإجراءات المتاحة ═══
1. query_visits            → استعلام زيارات أطباء أو صيدليات بمرونة تامة
2. query_doctors           → الحصول على قائمة أسماء الأطباء (بدون زيارات)
3. query_unvisited_doctors → أطباء لم تتم زيارتهم في فترة محددة أو منذ البداية
4. navigate                → الانتقال لصفحة
5. page_action             → تنفيذ إجراء داخل أي صفحة (مثل فتح نافذة أو إضافة عنصر)
6. unknown                 → لا يمكن فهم الطلب

═══ متى تستخدم query_unvisited_doctors ═══
• "من لم يتم زيارته" / "أطباء ما تزاروا" / "الأطباء غير المزارين" → query_unvisited_doctors
• "مين ما زاروه في منطقة X" / "أطباء منطقة X ما تزاروا" → query_unvisited_doctors + areaName
• "أطباء ما تزاروا في الحارثية والمعيقلية" → query_unvisited_doctors + areaNames:[...]
• "من لم يتم زيارته هذا الشهر" / "ما تزاروا هالشهر" → query_unvisited_doctors + month+year
• "من لم يزره مندوب X" / "أطباء ما زارهم سعد" → query_unvisited_doctors + repName
• إذا ذُكر تاريخ محدد → يعني ما تتم زيارتهم في تلك الفترة فقط
• إذا لم يُذكر تاريخ → يعني ما تمت زيارتهم إطلاقاً

═══ متى تستخدم query_doctors بدلاً من query_visits ═══
• "شنو الأطباء في منطقة X" / "من هم أطباء منطقة X" / "اسماء أطباء X" → query_doctors
• "اريد الأطباء في منطقة X" (بدون ذكر زيارات أو كولات) → query_doctors
• "قائمة الأطباء" / "أطباء التخصص X" → query_doctors
• "زيارات/كولات أطباء منطقة X" / "كم مرة زار الطبيب X" → query_visits (ليس query_doctors)

═══ الصفحات للانتقال (navigate) ═══
• dashboard        → الرئيسية / الداشبورد
• monthly-plans    → الخطط الشهرية
• doctors          → صفحة الأطباء / قائمة الأطباء
• scientific-reps  → المندوبين العلميين
• representatives  → المندوبين التجاريين
• reports          → التقارير
• users            → المستخدمين
• rep-analysis     → تحليل المندوب / تحليل الزيارات / تحليل المبيعات / تحليل أداء المندوب
• upload           → رفع الملفات

═══ إجراءات page_action (مع الصفحة المستهدفة) ═══

صفحة monthly-plans (الخطط الشهرية):
  • open-new-plan           → إنشاء / إضافة خطة شهرية جديدة
  • open-suggest-settings   → فتح إعدادات الاقتراح الذكي / الخطة الذكية / إعدادات الخطة
  • open-import-visits      → استيراد زيارات للخطة
  • open-plan               → فتح خطة مندوب معين (ضع اسم المندوب في pageActionParam)

صفحة doctors (الأطباء):
  • open-add-doctor         → إضافة طبيب جديد
  • open-import-doctors     → استيراد أطباء من ملف
  • open-coverage           → عرض خريطة التغطية / نسبة التغطية
  • open-wish-list          → فتح قائمة الطلبات / السيرفي / Wish List / قائمة الأمنيات / ويش ليست

صفحة scientific-reps (المندوبون العلميون):
  • open-add-sci-rep        → إضافة مندوب علمي جديد

صفحة representatives (المندوبون التجاريون):
  • open-add-rep            → إضافة مندوب تجاري جديد

صفحة users (المستخدمون):
  • open-add-user           → إضافة مستخدم جديد

صفحة dashboard (الرئيسية):
  • open-call-log           → فتح سجل الاتصالات / عرض قائمة الكولات
  • open-voice-call         → فتح نافذة الإدخال الصوتي للكول / تسجيل زيارة بالصوت / الكول الصوتي / ادخال صوتي
  • open-map                → عرض خريطة الزيارات اليومية

صفحة reports (التقارير):
  • open-export-report      → فتح نافذة تصدير التقرير

═══ قواعد page_action ═══
• إذا طلب المستخدم فتح نافذة أو إجراء في صفحة أخرى غير الحالية، استخدم page_action (النظام سيتنقل تلقائياً)
• إذا ذكر اسم مندوب مع طلب فتح خطته: pageAction:"open-plan", pageActionParam:"اسم المندوب"
• للإجراءات التي لا تحتاج معامل: pageActionParam: null

═══ فلاتر query_unvisited_doctors ═══
areaName  : اسم منطقة واحدة أو null
areaNames : مصفوفة أسماء مناطق للبحث في أكثر من منطقة — مثال: ["الحارثية","المعيقلية"] أو null لكل المناطق
repName   : اسم المندوب أو null (من لم يزره هذا المندوب تحديداً)
month     : رقم الشهر 1-12 أو null
year      : السنة أو null
day       : رقم اليوم 1-31 أو null

═══ فلاتر query_doctors ═══
areaName  : اسم المنطقة أو null
specialty : التخصص الطبي أو null
limit     : عدد النتائج (افتراضي 100)

═══ فلاتر query_visits ═══
visitType    : "doctor" | "pharmacy" | null  (دائماً "doctor" ما لم يذكر صيدلية/صيدليات)
areaName     : اسم المنطقة (مثل: الحارثية, المعيقلية...) أو null
repName      : اسم المندوب أو null
doctorName   : اسم الطبيب أو null (للأطباء فقط)
pharmacyName : اسم الصيدلية أو null (للصيدليات فقط)
itemName     : اسم الإيتم أو null
feedback     : مصفوفة من القيم أو قيمة واحدة أو null — مثال: ["writing","interested"] أو "stocked" أو null
               القيم المتاحة: writing | stocked | interested | not_interested | unavailable | pending
               (للأطباء فقط)
day          : رقم اليوم 1-31 أو null
month        : رقم الشهر 1-12 أو null
year         : السنة أو null
isDoubleVisit: true | false | null

═══ groupBy خيارات ═══
null        → قائمة مباشرة
"item"      → تجميع حسب الإيتم
"doctor"    → تجميع حسب الطبيب
"rep"       → تجميع حسب المندوب
"date"      → تجميع حسب التاريخ
"feedback"  → تجميع حسب التفاعل (للأطباء)
"pharmacy"  → تجميع حسب اسم الصيدلية (للصيدليات)
"area"      → تجميع حسب المنطقة

═══ قواعد الاختيار ═══
• "صيدلية"/"صيدليات"/"فارماسي"/"صيدلانية" → visitType:"pharmacy"
• أي اسم منطقة مذكور (مثل الحارثية, المعيقلية...) → areaName:"اسم المنطقة"
• إذا ذُكرت منطقة فقط (بدون طبيب بعينه) → groupBy:"doctor" تلقائياً
• صيدليات + منطقة → visitType:"pharmacy", areaName:"...", groupBy:"pharmacy"
• "يوم 10" / "في العاشر" → day:10, month:${curMonth}
• "هذا الشهر" / "الشهر الحالي" → month:${curMonth}, year:${curYear}
• "الشهر الماضي" → month:${curMonth === 1 ? 12 : curMonth - 1}, year:${curMonth === 1 ? curYear - 1 : curYear}
• "اليوم" → day:${curDay}, month:${curMonth}, year:${curYear}
• "حسب الأيتمات"/"لكل إيتم" → groupBy:"item"
• "حسب الأطباء"/"لكل طبيب" → groupBy:"doctor"
• "حسب المندوبين"/"لكل مندوب" → groupBy:"rep"
• "حسب التفاعل"/"حسب الفيدباك" → groupBy:"feedback"
• "حسب التاريخ"/"يومياً" → groupBy:"date"
• "حسب الصيدلية"/"لكل صيدلية" → groupBy:"pharmacy"
• "حسب المنطقة" → groupBy:"area"
• "كاتبين"/"يكتبون" → feedback:"writing"
• "نزّلوا"/"نزّل" → feedback:"stocked"
• "مهتمين" → feedback:"interested"
• "غير مهتمين"/"مو مهتمين" → feedback:"not_interested"
• "غير متوفر"/"ما فيه" → feedback:"unavailable"
• فيدباك واحد: feedback:"writing"
• فيدباكان: feedback:["writing","stocked"]
• "كاتبين ومهتمين" → feedback:["writing","interested"]
• "كاتبين ونزّلوا" → feedback:["writing","stocked"]
• "مهتمين وغير مهتمين" → feedback:["interested","not_interested"]
• ثلاثة فيدباكات: feedback:["writing","stocked","interested"]
• "زيارة مزدوجة"/"مع المدير"/"دبل" → isDoubleVisit:true
• limit افتراضي 50، زد لـ150 إذا قال "كل" أو "جميع"

═══ صيغة الرد (JSON فقط) ═══
{
  "action": "query_visits" | "query_doctors" | "query_unvisited_doctors" | "navigate" | "page_action" | "unknown",
  "navigatePage": null,
  "pageAction": null,
  "pageActionParam": null,
  "filters": {
    "visitType": null,
    "areaName": null,
    "areaNames": null,
    "repName": null,
    "doctorName": null,
    "pharmacyName": null,
    "itemName": null,
    "feedback": null,
    "feedbackList": null,
    "day": null,
    "month": null,
    "year": null,
    "isDoubleVisit": null
  },
  "groupBy": null,
  "sortBy": "date_desc",
  "limit": 50,
  "responseText": "جملة عربية تصف ما ستعرضه",
  "needsClarification": false,
  "question": ""
}`;
}

// ── Date filter builder ───────────────────────────────────────
function buildDateFilter(filters) {
  const now = new Date();
  const yr  = filters.year  || now.getFullYear();
  const mo  = filters.month ?? null;
  const dy  = filters.day   ?? null;
  if (dy !== null) {
    const m = mo !== null ? mo : now.getMonth() + 1;
    return { gte: new Date(yr, m - 1, dy, 0, 0, 0), lte: new Date(yr, m - 1, dy, 23, 59, 59) };
  }
  if (mo !== null) {
    return { gte: new Date(yr, mo - 1, 1), lt: new Date(yr, mo, 1) };
  }
  return null;
}

// ── Execute: Doctor Visits ────────────────────────────────────
async function executeDoctorQuery(spec, userId, areasList) {
  const { filters = {}, groupBy, sortBy, limit } = spec;
  const where = {};
  if (userId) where.userId = userId;

  // areaName filter — resolve to doctor.areaId via nested filter
  if (filters.areaName) {
    const area = fuzzyFind(areasList, 'name', filters.areaName);
    if (!area) return { found: false, message: `\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0645\u0646\u0637\u0642\u0629 "\u200f${filters.areaName}\u200f"` };
    where.doctor = { areaId: area.id };
  }

  // doctorName filter
  if (filters.doctorName) {
    const list = await prisma.doctor.findMany({
      where: userId ? { userId } : {},
      select: { id: true, name: true },
    });
    const found = fuzzyFind(list, 'name', filters.doctorName);
    if (!found) return { found: false, message: `\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0637\u0628\u064a\u0628 "\u200f${filters.doctorName}\u200f"` };
    where.doctorId = found.id;
  }

  // repName filter
  if (filters.repName) {
    const list = await prisma.scientificRepresentative.findMany({
      where: userId ? { userId } : {},
      select: { id: true, name: true },
    });
    const found = fuzzyFind(list, 'name', filters.repName);
    if (!found) return { found: false, message: `\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0645\u0646\u062f\u0648\u0628 "\u200f${filters.repName}\u200f"` };
    where.scientificRepId = found.id;
  }

  // itemName filter
  if (filters.itemName) {
    const list = await prisma.item.findMany({
      where: userId ? { userId } : {},
      select: { id: true, name: true },
    });
    const found = fuzzyFind(list, 'name', filters.itemName);
    if (!found) return { found: false, message: `\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0625\u064a\u062a\u0645 "\u200f${filters.itemName}\u200f"` };
    where.itemId = found.id;
  }

  // feedback — supports single string or array
  const fb = filters.feedbackList ?? filters.feedback;
  if (fb) {
    if (Array.isArray(fb) && fb.length > 0) {
      where.feedback = { in: fb };
    } else if (typeof fb === 'string') {
      where.feedback = fb;
    }
  }
  if (filters.isDoubleVisit === true || filters.isDoubleVisit === false) {
    where.isDoubleVisit = filters.isDoubleVisit;
  }

  const dateFilter = buildDateFilter(filters);
  if (dateFilter) where.visitDate = dateFilter;

  const orderBy = sortBy === 'date_asc' ? { visitDate: 'asc' } : { visitDate: 'desc' };
  const visits  = await prisma.doctorVisit.findMany({
    where,
    orderBy,
    take: Math.min(Number(limit) || 50, 150),
    include: {
      doctor:        { select: { name: true, specialty: true, area: { select: { name: true } } } },
      scientificRep: { select: { name: true } },
      item:          { select: { name: true } },
    },
  });

  if (!visits.length) {
    return { found: false, message: '\u0644\u0627 \u062a\u0648\u062c\u062f \u0632\u064a\u0627\u0631\u0627\u062a \u0623\u0637\u0628\u0627\u0621 \u062a\u0637\u0627\u0628\u0642 \u0627\u0644\u0628\u062d\u062b' };
  }

  const mapVisit = v => ({
    date:       v.visitDate,
    doctorName: v.doctor?.name           || '\u2014',
    specialty:  v.doctor?.specialty      || '',
    areaName:   v.doctor?.area?.name     || '',
    repName:    v.scientificRep?.name    || '\u2014',
    itemName:   v.item?.name             || '\u2014',
    feedback:   FEEDBACK_AR[v.feedback]  || v.feedback,
    notes:      v.notes  || '',
    isDouble:   v.isDoubleVisit,
  });

  if (groupBy) {
    const grouped = new Map();
    for (const v of visits) {
      let key;
      if      (groupBy === 'item')     key = v.item?.name             || '\u0628\u062f\u0648\u0646 \u0625\u064a\u062a\u0645';
      else if (groupBy === 'doctor')   key = v.doctor?.name           || '\u2014';
      else if (groupBy === 'rep')      key = v.scientificRep?.name    || '\u2014';
      else if (groupBy === 'feedback') key = FEEDBACK_AR[v.feedback]  || v.feedback;
      else if (groupBy === 'area')     key = v.doctor?.area?.name     || '\u0628\u062f\u0648\u0646 \u0645\u0646\u0637\u0642\u0629';
      else if (groupBy === 'date') {
        const d = new Date(v.visitDate);
        key = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
      } else key = '\u2014';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(v);
    }
    const groups = Array.from(grouped.entries())
      .map(([groupKey, vs]) => ({ groupKey, count: vs.length, visits: vs.map(mapVisit) }))
      .sort((a, b) => b.count - a.count);
    return { found: true, type: 'grouped_visits', visitType: 'doctor', groupBy, totalVisits: visits.length, groups };
  }

  return { found: true, type: 'visits_list', visitType: 'doctor', totalVisits: visits.length, visits: visits.map(mapVisit) };
}

// ── Execute: Pharmacy Visits ─────────────────────────────────
async function executePharmacyQuery(spec, userId, areasList) {
  const { filters = {}, groupBy, sortBy, limit } = spec;
  const where = {};
  if (userId) where.userId = userId;

  // areaName filter
  if (filters.areaName) {
    const area = fuzzyFind(areasList, 'name', filters.areaName);
    if (area) {
      where.areaId = area.id;
    } else {
      // fallback: free-text areaName field
      where.areaName = { contains: filters.areaName };
    }
  }

  // pharmacyName filter
  if (filters.pharmacyName) {
    where.pharmacyName = { contains: filters.pharmacyName };
  }

  // repName filter
  if (filters.repName) {
    const list = await prisma.scientificRepresentative.findMany({
      where: userId ? { userId } : {},
      select: { id: true, name: true },
    });
    const found = fuzzyFind(list, 'name', filters.repName);
    if (!found) return { found: false, message: `\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0645\u0646\u062f\u0648\u0628 "\u200f${filters.repName}\u200f"` };
    where.scientificRepId = found.id;
  }

  if (filters.isDoubleVisit === true || filters.isDoubleVisit === false) {
    where.isDoubleVisit = filters.isDoubleVisit;
  }

  const dateFilter = buildDateFilter(filters);
  if (dateFilter) where.visitDate = dateFilter;

  const orderBy = sortBy === 'date_asc' ? { visitDate: 'asc' } : { visitDate: 'desc' };
  const visits  = await prisma.pharmacyVisit.findMany({
    where,
    orderBy,
    take: Math.min(Number(limit) || 50, 150),
    include: {
      scientificRep: { select: { name: true } },
      area:          { select: { name: true } },
      items: {
        include: { item: { select: { name: true } } },
      },
    },
  });

  if (!visits.length) {
    return { found: false, message: '\u0644\u0627 \u062a\u0648\u062c\u062f \u0632\u064a\u0627\u0631\u0627\u062a \u0635\u064a\u062f\u0644\u064a\u0627\u062a \u062a\u0637\u0627\u0628\u0642 \u0627\u0644\u0628\u062d\u062b' };
  }

  const mapPharmacy = v => ({
    date:         v.visitDate,
    pharmacyName: v.pharmacyName,
    areaName:     v.area?.name || v.areaName || '\u2014',
    repName:      v.scientificRep?.name || '\u2014',
    itemNames:    v.items.map(i => i.item?.name || i.itemName || '').filter(Boolean),
    notes:        v.notes || '',
    isDouble:     v.isDoubleVisit,
  });

  if (groupBy) {
    const grouped = new Map();
    for (const v of visits) {
      let key;
      if      (groupBy === 'pharmacy') key = v.pharmacyName;
      else if (groupBy === 'area')     key = v.area?.name || v.areaName || '\u2014';
      else if (groupBy === 'rep')      key = v.scientificRep?.name || '\u2014';
      else if (groupBy === 'date') {
        const d = new Date(v.visitDate);
        key = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
      } else key = v.pharmacyName;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(v);
    }
    const groups = Array.from(grouped.entries())
      .map(([groupKey, vs]) => ({ groupKey, count: vs.length, visits: vs.map(mapPharmacy) }))
      .sort((a, b) => b.count - a.count);
    return { found: true, type: 'grouped_visits', visitType: 'pharmacy', groupBy, totalVisits: visits.length, groups };
  }

  return { found: true, type: 'visits_list', visitType: 'pharmacy', totalVisits: visits.length, visits: visits.map(mapPharmacy) };
}

// ── Execute: Unvisited Doctors ───────────────────────────────
async function executeUnvisitedDoctorsQuery(spec, userId) {
  const { filters = {} } = spec;
  const { areaName, areaNames, repName } = filters;

  const areasList = await prisma.area.findMany({
    where: userId ? { userId } : {},
    select: { id: true, name: true },
  }).catch(() => []);

  // Resolve area IDs — supports single string or array
  let areaIds = null;
  const rawAreas = areaNames
    ? (Array.isArray(areaNames) ? areaNames : [areaNames])
    : areaName
      ? (Array.isArray(areaName) ? areaName : [areaName])
      : null;

  if (rawAreas && rawAreas.length > 0) {
    areaIds = [];
    for (const name of rawAreas) {
      const area = fuzzyFind(areasList, 'name', name);
      if (!area) return { found: false, message: `لم يتم العثور على منطقة "${name}"` };
      areaIds.push(area.id);
    }
  }

  // Resolve rep
  let repId = null;
  if (repName) {
    const list = await prisma.scientificRepresentative.findMany({
      where: userId ? { userId } : {},
      select: { id: true, name: true },
    });
    const found = fuzzyFind(list, 'name', repName);
    if (!found) return { found: false, message: `لم يتم العثور على مندوب "${repName}"` };
    repId = found.id;
  }

  // Build date filter for the visits lookup
  const dateFilter = buildDateFilter(filters);

  // Find doctor IDs that HAVE visits in the period
  const visitWhere = {};
  if (userId) visitWhere.userId = userId;
  if (repId)  visitWhere.scientificRepId = repId;
  if (dateFilter) visitWhere.visitDate = dateFilter;
  if (areaIds)    visitWhere.doctor = { areaId: { in: areaIds } };

  const visitedRows = await prisma.doctorVisit.findMany({
    where: visitWhere,
    select: { doctorId: true },
    distinct: ['doctorId'],
  });
  const visitedIds = visitedRows.map(v => v.doctorId);

  // Doctors NOT in visited list
  const doctorWhere = {};
  if (userId) doctorWhere.userId = userId;
  if (areaIds) doctorWhere.areaId = { in: areaIds };
  if (visitedIds.length > 0) doctorWhere.id = { notIn: visitedIds };

  const doctors = await prisma.doctor.findMany({
    where: doctorWhere,
    take: Math.min(Number(spec.limit) || 300, 500),
    include: { area: { select: { name: true } } },
    orderBy: [{ area: { name: 'asc' } }, { name: 'asc' }],
  });

  if (!doctors.length) {
    return {
      found: true,
      type: 'unvisited_doctors',
      totalDoctors: 0,
      groups: [],
      doctors: [],
      allVisited: true,
    };
  }

  // Group by area
  const byArea = new Map();
  for (const d of doctors) {
    const area = d.area?.name || 'بدون منطقة';
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push({ name: d.name, specialty: d.specialty || '', areaName: area, phone: d.phone || '' });
  }

  return {
    found: true,
    type: 'unvisited_doctors',
    totalDoctors: doctors.length,
    groups: Array.from(byArea.entries()).map(([aName, docs]) => ({ areaName: aName, doctors: docs })),
    doctors: doctors.map(d => ({ name: d.name, specialty: d.specialty || '', areaName: d.area?.name || '', phone: d.phone || '' })),
  };
}

// ── Execute: Doctor List (no visits) ─────────────────────────
async function executeDoctorListQuery(spec, userId) {
  const { filters = {} } = spec;
  const { areaName, specialty } = filters;

  const where = {};
  if (userId) where.userId = userId;

  if (areaName) {
    const areasList = await prisma.area.findMany({
      where: userId ? { userId } : {},
      select: { id: true, name: true },
    }).catch(() => []);
    const area = fuzzyFind(areasList, 'name', areaName);
    if (!area) return { found: false, message: `لم يتم العثور على منطقة "${areaName}"` };
    where.areaId = area.id;
  }

  if (specialty) {
    where.specialty = { contains: specialty };
  }

  const doctors = await prisma.doctor.findMany({
    where,
    take: Math.min(Number(spec.limit) || 100, 200),
    include: { area: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });

  if (!doctors.length) {
    return { found: false, message: 'لا يوجد أطباء يطابقون البحث' };
  }

  return {
    found: true,
    type: 'doctor_list',
    totalDoctors: doctors.length,
    doctors: doctors.map(d => ({
      name:      d.name,
      specialty: d.specialty || '',
      areaName:  d.area?.name || '',
      phone:     d.phone || '',
    })),
  };
}

// ── Dispatch ─────────────────────────────────────────────────
async function executeQuery(spec, userId) {
  const areasList = await prisma.area.findMany({
    where: userId ? { userId } : {},
    select: { id: true, name: true },
    take: 100,
  }).catch(() => []);

  if (spec.filters?.visitType === 'pharmacy') {
    return executePharmacyQuery(spec, userId, areasList);
  }
  return executeDoctorQuery(spec, userId, areasList);
}

// ── API Key rotation (round-robin across up to 3 keys) ──────
let _keyIndex = 0;
function getNextApiKey() {
  const keys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
  ].filter(Boolean);
  if (!keys.length) return '';
  const key = keys[_keyIndex % keys.length];
  _keyIndex = (_keyIndex + 1) % keys.length;
  return key;
}

// ── Main handler ─────────────────────────────────────────────
export async function handleCommand(req, res) {
  try {
    const apiKey = getNextApiKey();
    if (!apiKey) return res.status(500).json({ success: false, error: '\u0645\u0641\u062a\u0627\u062d Gemini \u063a\u064a\u0631 \u0645\u0647\u064a\u0623' });

    let context = {};
    try {
      const raw = req.body?.context;
      if (raw) context = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { /* ignore */ }

    const textInput = req.body?.text || '';
    const hasAudio  = !!req.file;
    const hasText   = textInput.trim().length > 0;
    if (!hasAudio && !hasText) {
      return res.status(400).json({ success: false, error: '\u0644\u0645 \u064a\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0635\u0648\u062a \u0623\u0648 \u0646\u0635' });
    }

    const userId = req.user?.id;

    const [repsRaw, docsRaw, itemsRaw, areasRaw, plansRaw] = await Promise.all([
      prisma.scientificRepresentative.findMany({
        where: userId ? { userId } : {},
        select: { name: true }, take: 60, orderBy: { name: 'asc' },
      }).catch(() => []),
      prisma.doctor.findMany({
        where: userId ? { userId } : {},
        select: { name: true }, take: 60, orderBy: { name: 'asc' },
      }).catch(() => []),
      prisma.item.findMany({
        where: userId ? { userId } : {},
        select: { name: true }, take: 60, orderBy: { name: 'asc' },
      }).catch(() => []),
      prisma.area.findMany({
        where: userId ? { userId } : {},
        select: { name: true }, take: 60, orderBy: { name: 'asc' },
      }).catch(() => []),
      prisma.monthlyPlan.findMany({
        where: userId ? { userId } : {},
        select: { scientificRep: { select: { name: true } } },
        take: 60,
      }).catch(() => []),
    ]);

    const systemPrompt = buildSystemPrompt({
      currentPage: context.currentPage || 'غير محددة',
      userRole:    context.userRole    || req.user?.role || 'user',
      repNames:    repsRaw.map(r => r.name),
      doctorNames: docsRaw.map(d => d.name),
      itemNames:   itemsRaw.map(i => i.name),
      areaNames:   areasRaw.map(a => a.name),
      planNames:   [...new Set(plansRaw.map(p => p.scientificRep?.name).filter(Boolean))],
    });

    const genAI = new GoogleGenerativeAI(apiKey);
    let geminiText;

    // ── Retry helper: up to 3 attempts with exponential backoff on 429 ──
    async function callGemini(parts, retries = 3, delayMs = 2000) {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const result = await model.generateContent(parts);
          return result.response.text();
        } catch (err) {
          const is429 = String(err?.message || '').includes('429') || err?.status === 429;
          if (is429 && attempt < retries) {
            await new Promise(r => setTimeout(r, delayMs * attempt));
          } else {
            throw err;
          }
        }
      }
    }

    if (hasAudio) {
      const audioData   = fs.readFileSync(req.file.path);
      const audioBase64 = audioData.toString('base64');
      const mimeType    = req.file.mimetype || 'audio/webm';
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      geminiText = await callGemini([
        systemPrompt,
        { inlineData: { mimeType, data: audioBase64 } },
        '\u0627\u0633\u062a\u0645\u0639 \u0644\u0644\u062a\u0633\u062c\u064a\u0644 \u0648\u0623\u0631\u062c\u0639 JSON \u0641\u0642\u0637.',
      ]);
    } else {
      geminiText = await callGemini([
        systemPrompt,
        `\u0623\u0645\u0631 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645: "${textInput}"\n\u0623\u0631\u062c\u0639 JSON \u0641\u0642\u0637.`,
      ]);
    }

    const jsonMatch = geminiText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(422).json({ success: false, error: '\u062a\u0639\u0630\u0631 \u062a\u062d\u0644\u064a\u0644 \u0631\u062f Gemini', raw: geminiText });
    }

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch { return res.status(422).json({ success: false, error: 'JSON \u063a\u064a\u0631 \u0635\u0627\u0644\u062d', raw: geminiText }); }

    let queryResult = null;
    if (parsed.action === 'query_visits') {
      queryResult = await executeQuery(parsed, userId);
    } else if (parsed.action === 'query_doctors') {
      queryResult = await executeDoctorListQuery(parsed, userId);
    } else if (parsed.action === 'query_unvisited_doctors') {
      queryResult = await executeUnvisitedDoctorsQuery(parsed, userId);
    }

    const validPages = ['dashboard','upload','representatives','scientific-reps','doctors','monthly-plans','reports','users','rep-analysis'];
    const navigatePage = (parsed.action === 'navigate' && validPages.includes(parsed.navigatePage))
      ? parsed.navigatePage : null;

    const validPageActions = [
      'open-suggest-settings', 'open-new-plan', 'open-import-visits', 'open-plan',
      'open-add-doctor', 'open-import-doctors', 'open-coverage', 'open-wish-list',
      'open-add-sci-rep', 'open-add-rep', 'open-add-user',
      'open-call-log', 'open-voice-call', 'open-map', 'open-export-report',
    ];
    const pageAction = (parsed.action === 'page_action' && validPageActions.includes(parsed.pageAction))
      ? parsed.pageAction : null;
    const pageActionParam = pageAction ? (parsed.pageActionParam ?? null) : null;

    return res.json({ success: true, data: { ...parsed, navigatePage, pageAction, pageActionParam, queryResult } });

  } catch (err) {
    console.error('[ai-assistant] error:', err);
    return res.status(500).json({ success: false, error: err.message || '\u062e\u0637\u0623 \u063a\u064a\u0631 \u0645\u062a\u0648\u0642\u0639' });
  }
}
