import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import prisma from '../../lib/prisma.js';

// ── Constants ────────────────────────────────────────────────
const FEEDBACK_AR = {
  writing:        '\u064a\u0643\u062a\u0628 \u270d\ufe0f',
  stocked:        '\u064a\u0648\u062c\u062f \u0643\u0648\u0645\u0628\u062a\u062a\u0631 \u2694\ufe0f',
  interested:     '\u0645\u0647\u062a\u0645 \ud83d\udc4d',
  not_interested: '\u063a\u064a\u0631 \u0645\u0647\u062a\u0645 \ud83d\udc4e',
  unavailable:    '\u0645\u062a\u0627\u0628\u0639\u0629 \u0648\u062a\u0630\u0643\u064a\u0631 \ud83d\udd14',
  pending:        '\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u0641\u064a\u062f\u0628\u0627\u0643 \u23f3',
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
                   (writing=يكتب, stocked=يوجد كومبتتر/منافس, interested=مهتم, not_interested=غير مهتم, unavailable=متابعة وتذكير, pending=بانتظار الفيدباك)
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
الأطباء (للاستعلام فقط — لا تستبدل اسم الطبيب الذي نطقه المستخدم بأي اسم من هذه القائمة): ${docsText}
الأيتمات: ${itemsText}
المناطق: ${areasText}
الخطط الشهرية (أسماء المندوبين): ${plansText}

═══ الإجراءات المتاحة ═══
1. query_visits            → استعلام زيارات أطباء أو صيدليات بمرونة تامة
2. query_doctors           → الحصول على قائمة أسماء الأطباء (بدون زيارات)
3. query_unvisited_doctors → أطباء لم تتم زيارتهم في فترة محددة أو منذ البداية
4. query_stats             → إحصائيات وملخص سريع للزيارات (كم زيارة، أكثر ايتم، أكثر منطقة...)
5. query_plan_stats        → نسبة تحقيق البلان الشهري (كم المطلوب وكم المنجز ونسبة التحقيق)
6. navigate                → الانتقال لصفحة
7. page_action             → تنفيذ إجراء داخل أي صفحة (مثل فتح نافذة أو إضافة عنصر)
8. unknown                 → لا يمكن فهم الطلب

═══ متى تستخدم query_unvisited_doctors ═══
• "من لم يتم زيارته" / "أطباء ما تزاروا" / "الأطباء غير المزارين" → query_unvisited_doctors
• "مين ما زاروه في منطقة X" / "أطباء منطقة X ما تزاروا" → query_unvisited_doctors + areaName
• "أطباء ما تزاروا في الحارثية والمعيقلية" → query_unvisited_doctors + areaNames:[...]
• "من لم يتم زيارته هذا الشهر" / "ما تزاروا هالشهر" → query_unvisited_doctors + month+year
• "من لم يزره مندوب X" / "أطباء ما زارهم سعد" → query_unvisited_doctors + repName
• إذا ذُكر تاريخ محدد → يعني ما تتم زيارتهم في تلك الفترة فقط
• إذا لم يُذكر تاريخ → يعني ما تمت زيارتهم إطلاقاً

═══ متى تستخدم query_plan_stats ═══
• "نسبة البلان" / "تقدم البلان" / "نسبة التحقيق" / "كم حققت من البلان" / "شكد باقي" → query_plan_stats
• "كم طبيب بالبلان" / "كم مطلوب أزور" / "عدد الكولات المطلوبة" → query_plan_stats
• "نسبة تحقيق الايتم X" / "شكد زرت من ايتم X" → query_plan_stats + itemName
• "نسبة البلان في منطقة X" / "كم حققت بمنطقة X" / "شكد باقي بمنطقة X" → query_plan_stats + areaName
• "بلان شهر 2" / "بلان شهر فبراير" → query_plan_stats + month:2
• إذا لم يُذكر شهر → الشهر الحالي ${curMonth}/${curYear} تلقائياً

═══ فلاتر query_plan_stats ═══
areaName : اسم المنطقة أو null
itemName : اسم الايتم أو null
month    : رقم الشهر 1-12 أو null (افتراضي الشهر الحالي)
year     : السنة أو null (افتراضي السنة الحالية)

═══ متى تستخدم query_stats ═══
• "كم زيارة" / "كمية الزيارات" / "إحصائيات" / "ملخص الزيارات" / "تقرير سريع" → query_stats
• "أكثر إيتم مزار" / "أكثر منطقة فيها زيارات" / "أكثر مندوب زيارة" → query_stats + groupBy مناسب
• "إحصائيات هذا الشهر" / "ملخص شهر X" / "كم زيارة لإيتم X" → query_stats
• "نسبة الزيارات" / "توزيع الزيارات" / "إجمالي" → query_stats
• استخدم query_stats عند السؤال عن أعداد وإحصائيات لا عن قائمة تفصيلية

═══ متى تستخدم query_doctors بدلاً من query_visits ═══
• "شنو الأطباء في منطقة X" / "من هم أطباء منطقة X" / "اسماء أطباء X" / "اطباء X" (بدون ذكر تخصص) → page_action: open-doctors-area + pageActionParam: اسم المنطقة (يفتح صفحة الأطباء مع فلتر المنطقة)
• "اريد الأطباء في منطقة X" (بدون ذكر تخصص أو شروط إضافية) → page_action: open-doctors-area + pageActionParam: اسم المنطقة
• ⚠️ إذا ذُكر تخصص + منطقة معاً: استخدم query_doctors (وليس open-doctors-area) لأن page_action لا يدعم فلتر التخصص
  - "أطباء باطنية في منطقة العامرية" → query_doctors + specialty:"باطنية" + areaName:"العامرية"
  - "الأطباء الي اختصاصهم ENT في الحارثية" → query_doctors + specialty:"ENT" + areaName:"الحارثية"
  - "أطباء جلدية بالمنصور" → query_doctors + specialty:"جلدية" + areaName:"المنصور"
  - "أطباء عيون في الكرادة" → query_doctors + specialty:"عيون" + areaName:"الكرادة"
• "قائمة الأطباء" / "أطباء التخصص X" (بدون ذكر منطقة) → query_doctors + specialty
• "هذا الطبيب من أي منطقة" / "دكتور X من وين" / "منطقة دكتور X" → query_doctors + doctorName
• "وين صيدلية X" / "صيدلية X بأي منطقة" → query_doctors + pharmacyName (سيبحث في بيانات الصيدليات)
• "زيارات/كولات أطباء منطقة X" / "كم مرة زار الطبيب X" → query_visits (ليس query_doctors)
• "دزلي سيرفي منطقة X" / "اريد السيرفي الخاص بمنطقة X" → page_action: open-wish-list-area + pageActionParam: اسم المنطقة

═══ قاعدة مهمة: الأوامر المركبة ═══
عندما يذكر المستخدم أكثر من شرط (تخصص + منطقة، أو اسم + منطقة، أو تخصص + صيدلية...):
→ استخدم query_doctors مع جميع الفلاتر معاً في نفس الطلب
مثال: "أطباء باطنية في العامرية" → action:"query_doctors", filters:{specialty:"باطنية", areaName:"العامرية"}
مثال: "أطباء الجلدية الي بصيدلية النور" → action:"query_doctors", filters:{specialty:"جلدية", pharmacyName:"النور"}

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
  • open-wish-list-area     → فتح السيرفي مع تصفية بمنطقة معينة (ضع اسم المنطقة في pageActionParam)
  • open-doctors-area       → فتح قائمة الأطباء مع تصفية بمنطقة معينة (ضع اسم المنطقة في pageActionParam)

صفحة scientific-reps (المندوبون العلميون):
  • open-add-sci-rep        → إضافة مندوب علمي جديد

صفحة representatives (المندوبون التجاريون):
  • open-add-rep            → إضافة مندوب تجاري جديد

صفحة users (المستخدمون):
  • open-add-user           → إضافة مستخدم جديد

صفحة dashboard (الرئيسية):
  • open-call-log           → فتح سجل الاتصالات / عرض قائمة الكولات
  • open-voice-call         → فتح نافذة الإدخال الصوتي للكول / تسجيل زيارة بالصوت / الكول الصوتي / ادخال صوتي
  • fill-visit-form         → تسجيل زيارة طبيب من الكلام المباشر (ضع بيانات الزيارة في pageActionParam ككائن JSON)
  • fill-pharmacy-visit     → تسجيل زيارة صيدلية من الكلام المباشر (ضع بيانات الزيارة في pageActionParam ككائن JSON)
  • open-map                → عرض خريطة الزيارات اليومية

صفحة reports (التقارير):
  • open-export-report      → فتح نافذة تصدير التقرير

═══ قواعد page_action ═══
• إذا طلب المستخدم فتح نافذة أو إجراء في صفحة أخرى غير الحالية، استخدم page_action (النظام سيتنقل تلقائياً)
• إذا ذكر اسم مندوب مع طلب فتح خطته: pageAction:"open-plan", pageActionParam:"اسم المندوب"
• للإجراءات التي لا تحتاج معامل: pageActionParam: null
• إذا وصف المستخدم زيارة طبيب (ذكر اسم الطبيب + ايتم أو فيدباك أو ملاحظات): pageAction:"fill-visit-form", pageActionParam: كائن JSON بالشكل:
  {"doctorName":"اسم الطبيب كما نطقه المستخدم حرفياً — لا تغيّره ولا تصححه ولا تستبدله باسم مشابه من القائمة","itemName":"اسم الايتم أو null","feedback":"writing|stocked|interested|not_interested|unavailable|pending أو null","notes":"الملاحظات أو null","specialty":"التخصص أو null","pharmacyName":"اسم الصيدلية أو null","areaName":"اسم المنطقة أو null"}
⚠️ مهم جداً: ضع اسم الطبيب بالضبط كما قاله المستخدم. مثلاً إذا قال "حكمت ناجي" اكتب "حكمت ناجي" حتى لو وجدت اسم مشابه في القائمة مثل "احمد حكمت". النظام الأمامي سيتولى المطابقة الذكية.
• أمثلة fill-visit-form:
  - "سجل زيارة دكتور احمد، ايتم لوسارتان، كاتب" → pageAction:"fill-visit-form", pageActionParam:{"doctorName":"احمد","itemName":"لوسارتان","feedback":"writing","notes":null}
  - "اكتب كول دكتور محمد الحسيني، نزّل، ايتم أموكسيسيللين، ملاحظة سيزيد الكمية" → pageAction:"fill-visit-form", pageActionParam:{"doctorName":"محمد الحسيني","itemName":"أموكسيسيللين","feedback":"stocked","notes":"سيزيد الكمية"}
  - "زرت دكتور علي، مهتم" → pageAction:"fill-visit-form", pageActionParam:{"doctorName":"علي","itemName":null,"feedback":"interested","notes":null}
  - "سجل زيارة دكتور سعد، ايتم باراسيتامول، غير مهتم، ملاحظة: يفضل البديل" → pageAction:"fill-visit-form", pageActionParam:{"doctorName":"سعد","itemName":"باراسيتامول","feedback":"not_interested","notes":"يفضل البديل"}

  ══ قواعد استنتاج الفيدباك من الكلام الطبيعي ══
  استنتج feedback من المعنى حتى لو لم يُستخدم المصطلح الدقيق:
  • writing (يكتب): "بلّش يكتب"/"بدأ يكتب"/"صار يكتب"/"اشترى"/"طلب"/"اشتغل على الإيتم"/"ال dose نزلت عنده" → writing
  • stocked (يوجد كومبتتر): "عنده منافس"/"يستخدم منتج ثاني"/"مو موالي"/"عنده بديل"/"ما يتغير"/"مشغول بشركة ثانية"/"كومبتتر" → stocked
  • interested (مهتم): "عجبه"/"طلب معلومات أكثر"/"ايجابي"/"متحمس"/"شايف مصلحة"/"اشتغلنا عليه"/"واعد" → interested
  • not_interested (غير مهتم): "ما عجبه"/"رفض"/"ما يريد"/"قال لا"/"يرفض"/"سلبي"/"ما مهتم" → not_interested
  • unavailable (متابعة وتذكير): "غداً"/"بعدين"/"موعد ثاني"/"حاول مرة ثانية"/"اتصل لاحقاً"/"تذكير"/"متابعة"/"رجع عليه"/"ما كان موجود" → unavailable
  • pending (بانتظار الفيدباك): عندما لا تُذكر أي نتيجة أو ردة فعل واضحة → pending
• إذا وصف المستخدم زيارة صيدلية (ذكر اسم صيدلية + ايتمات أو منطقة): pageAction:"fill-pharmacy-visit", pageActionParam: كائن JSON بالشكل:
  {"pharmacyName":"اسم الصيدلية","areaName":"اسم المنطقة أو null","items":[{"itemName":"اسم الايتم","notes":"ملاحظة أو null"}],"notes":"ملاحظات عامة أو null"}
• أمثلة fill-pharmacy-visit:
  - "سجل زيارة صيدلية النور، منطقة الكرادة، ايتم لوسارتان وايتم أموكسيسيللين" → pageAction:"fill-pharmacy-visit", pageActionParam:{"pharmacyName":"النور","areaName":"الكرادة","items":[{"itemName":"لوسارتان","notes":null},{"itemName":"أموكسيسيللين","notes":null}],"notes":null}
  - "زرت صيدلية العين، ايتم باراسيتامول نزّل 5 علب" → pageAction:"fill-pharmacy-visit", pageActionParam:{"pharmacyName":"العين","areaName":null,"items":[{"itemName":"باراسيتامول","notes":"نزّل 5 علب"}],"notes":null}
• إذا طلب المستخدم السيرفي في منطقة معينة: pageAction:"open-wish-list-area", pageActionParam:"اسم المنطقة"
• أمثلة open-wish-list-area:
  - "دزلي سيرفي منطقة الحارثية" / "اريد السيرفي الخاص بالحارثية" → pageAction:"open-wish-list-area", pageActionParam:"الحارثية"
  - "ابي اشوف سيرفي حي العامل" → pageAction:"open-wish-list-area", pageActionParam:"حي العامل"
• إذا طلب المستخدم أطباء منطقة معينة أو قائمة أطباء منطقة (بدون ذكر سيرفي): pageAction:"open-doctors-area", pageActionParam:"اسم المنطقة"
• أمثلة open-doctors-area:
  - "اطباء منطقة الحارثية" / "شنو الأطباء في الحارثية" → pageAction:"open-doctors-area", pageActionParam:"الحارثية"
  - "ابي اشوف اطباء منطقة حي العامل" → pageAction:"open-doctors-area", pageActionParam:"حي العامل"
  - "من هم أطباء المنصور" → pageAction:"open-doctors-area", pageActionParam:"المنصور"
• إذا سأل المستخدم عن طبيب أو صيدلية في أي منطقة ("هذا الطبيب من أي منطقة" / "وين صيدلية X"): استخدم query_doctors مع doctorName أو query_visits مع pharmacyName — الجواب سيتضمن اسم المنطقة

═══ فلاتر query_unvisited_doctors ═══
areaName  : اسم منطقة واحدة أو null
areaNames : مصفوفة أسماء مناطق للبحث في أكثر من منطقة — مثال: ["الحارثية","المعيقلية"] أو null لكل المناطق
repName   : اسم المندوب أو null (من لم يزره هذا المندوب تحديداً)
month     : رقم الشهر 1-12 أو null
year      : السنة أو null
day       : رقم اليوم 1-31 أو null

═══ فلاتر query_doctors ═══
areaName     : اسم المنطقة أو null
specialty    : التخصص الطبي أو null — أمثلة: باطنية، جلدية، عيون، أطفال، عام، قلب، ENT، Dermato، أنف أذن حنجرة
               يمكن دمج specialty مع areaName للبحث المركب (مثل: أطباء باطنية في العامرية)
doctorName   : اسم الطبيب للبحث عنه أو null (عند السؤال عن طبيب معين: "دكتور X من وين" / "هذا الطبيب من أي منطقة")
pharmacyName : اسم الصيدلية للبحث عنها أو null (عند السؤال عن صيدلية معينة: "صيدلية X بأي منطقة")
limit        : عدد النتائج (افتراضي 100)

═══ فلاتر query_visits ═══
visitType    : "doctor" | "pharmacy" | null  (دائماً "doctor" ما لم يذكر صيدلية/صيدليات)
areaName     : اسم منطقة واحدة (مثل: الحارثية, المعيقلية...) أو null
areaNames    : مصفوفة أسماء مناطق للبحث في أكثر من منطقة — مثال: ["الحارثية","المعيقلية"] أو null
repName      : اسم المندوب أو null
doctorName   : اسم الطبيب أو null (للأطباء فقط)
pharmacyName : اسم الصيدلية أو null (للصيدليات فقط)
itemName     : اسم الإيتم أو null
specialty    : تخصص الطبيب (مثل: قلب، عيون، جلدية، عام، أطفال...) أو null
feedback     : مصفوفة من القيم أو قيمة واحدة أو null — مثال: ["writing","interested"] أو "stocked" أو null
               القيم المتاحة: writing | stocked | interested | not_interested | unavailable | pending
               (للأطباء فقط)
day          : رقم اليوم 1-31 أو null
month        : رقم الشهر 1-12 أو null
year         : السنة أو null
dateRelative : "today" | "tomorrow" | "yesterday" | "this_week" | null — يُستخدم بدلاً من day/month/year للتواريخ النسبية
isDoubleVisit: true | false | null

═══ فلاتر query_stats ═══
visitType    : "doctor" | "pharmacy" | "all" | null
repName      : اسم المندوب أو null
areaName     : اسم منطقة أو null
itemName     : اسم إيتم أو null
day          : رقم اليوم أو null
month        : رقم الشهر أو null
year         : السنة أو null
dateRelative : "today" | "tomorrow" | "yesterday" | "this_week" | null
groupBy (لـ query_stats): "area" | "item" | "rep" | "feedback" | "date" | null

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
• إذا ذُكرت منطقتان أو أكثر → areaNames:["منطقة1","منطقة2"]
• إذا ذُكر تخصص طبيب → specialty:"التخصص"
• صيدليات + منطقة → visitType:"pharmacy", areaName:"...", groupBy:"pharmacy"
• "يوم 10" / "في العاشر" → day:10, month:${curMonth}
• "هذا الشهر" / "الشهر الحالي" → month:${curMonth}, year:${curYear}
• "الشهر الماضي" → month:${curMonth === 1 ? 12 : curMonth - 1}, year:${curMonth === 1 ? curYear - 1 : curYear}
• "اليوم" / "اليوم الحالي" / "هاليوم" → dateRelative:"today"
• "غدا" / "غداً" / "بكرا" / "بكره" / "اليوم التالي" / "اليوم القادم" → dateRelative:"tomorrow"
• "أمس" / "البارحة" / "أمسية" / "اليوم الماضي" → dateRelative:"yesterday"
• "هذا الأسبوع" / "الأسبوع الحالي" / "هالأسبوع" → dateRelative:"this_week"
• إذا ذُكر يوم بدون تاريخ نسبي → استخدم day+month (month الحالي هو ${curMonth})
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
  "action": "query_visits" | "query_doctors" | "query_unvisited_doctors" | "query_stats" | "query_plan_stats" | "navigate" | "page_action" | "unknown",
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
    "specialty": null,
    "feedback": null,
    "feedbackList": null,
    "day": null,
    "month": null,
    "year": null,
    "dateRelative": null,
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

  // Handle relative dates first
  if (filters.dateRelative) {
    switch (filters.dateRelative) {
      case 'today': {
        return {
          gte: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0),
          lte: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59),
        };
      }
      case 'tomorrow': {
        const tom = new Date(now);
        tom.setDate(tom.getDate() + 1);
        return {
          gte: new Date(tom.getFullYear(), tom.getMonth(), tom.getDate(), 0, 0, 0),
          lte: new Date(tom.getFullYear(), tom.getMonth(), tom.getDate(), 23, 59, 59),
        };
      }
      case 'yesterday': {
        const yes = new Date(now);
        yes.setDate(yes.getDate() - 1);
        return {
          gte: new Date(yes.getFullYear(), yes.getMonth(), yes.getDate(), 0, 0, 0),
          lte: new Date(yes.getFullYear(), yes.getMonth(), yes.getDate(), 23, 59, 59),
        };
      }
      case 'this_week': {
        const day = now.getDay(); // 0=Sun
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - day);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        return {
          gte: new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate(), 0, 0, 0),
          lte: new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate(), 23, 59, 59),
        };
      }
    }
  }

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
  if (filters.areaNames && Array.isArray(filters.areaNames) && filters.areaNames.length > 0) {
    const areaIds = [];
    for (const name of filters.areaNames) {
      const area = fuzzyFind(areasList, 'name', name);
      if (area) areaIds.push(area.id);
    }
    if (areaIds.length > 0) where.doctor = { areaId: { in: areaIds } };
  } else if (filters.areaName) {
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

  // specialty filter — filter by doctor's specialty
  if (filters.specialty) {
    where.doctor = { ...( where.doctor ?? {}), specialty: { contains: filters.specialty } };
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

// ── Execute: Plan Stats (تقدم البلان الشهري) ─────────────────
async function executePlanStatsQuery(spec, userId) {
  const { filters = {} } = spec;
  const now = new Date();
  const month = filters.month ?? (now.getMonth() + 1);
  const year  = filters.year  ?? now.getFullYear();

  const REP_ROLES = ['user','scientific_rep','team_leader','supervisor','commercial_rep'];
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  const isRep = user && REP_ROLES.includes(user.role);
  const planWhere = isRep
    ? { month, year, OR: [{ userId }, { assignedUserId: userId }] }
    : { month, year, userId };

  const plan = await prisma.monthlyPlan.findFirst({
    where: planWhere,
    include: {
      scientificRep: { select: { name: true } },
      entries: {
        where: { isExtraVisit: false },
        include: {
          doctor: { select: { name: true, area: { select: { id: true, name: true } } } },
          visits: { select: { id: true, itemId: true, feedback: true } },
          targetItems: { include: { item: { select: { id: true, name: true } } } },
        },
      },
    },
  });

  if (!plan) return { found: false, type: 'plan_stats', message: `لا يوجد بلان لشهر ${month}/${year}` };

  const entries = plan.entries || [];
  const totalDoctors = entries.length;
  const totalTargetVisits = entries.reduce((s, e) => s + (e.targetVisits || 2), 0);
  const totalActualVisits = entries.reduce((s, e) => s + (e.visits?.length || 0), 0);
  const visitedDoctors = entries.filter(e => (e.visits?.length || 0) > 0).length;
  const completionPct = totalTargetVisits > 0 ? Math.round((totalActualVisits / totalTargetVisits) * 100) : 0;
  const doctorCoveragePct = totalDoctors > 0 ? Math.round((visitedDoctors / totalDoctors) * 100) : 0;

  // By area
  const areaMap = new Map();
  for (const e of entries) {
    const aName = e.doctor?.area?.name || 'بدون منطقة';
    if (!areaMap.has(aName)) areaMap.set(aName, { target: 0, visited: 0, targetVisits: 0, actualVisits: 0 });
    const a = areaMap.get(aName);
    a.target++;
    a.targetVisits += (e.targetVisits || 2);
    a.actualVisits += (e.visits?.length || 0);
    if ((e.visits?.length || 0) > 0) a.visited++;
  }
  const byArea = Array.from(areaMap.entries()).map(([name, d]) => ({
    name, targetDoctors: d.target, visitedDoctors: d.visited,
    targetVisits: d.targetVisits, actualVisits: d.actualVisits,
    pct: d.targetVisits > 0 ? Math.round((d.actualVisits / d.targetVisits) * 100) : 0,
  })).sort((a, b) => b.targetDoctors - a.targetDoctors);

  // By item
  const itemMap = new Map();
  for (const e of entries) {
    const items = (e.targetItems || []).map(ti => ti.item);
    for (const it of items) {
      if (!it) continue;
      if (!itemMap.has(it.name)) itemMap.set(it.name, { targetDoctors: 0, visitedDoctors: 0 });
      const rec = itemMap.get(it.name);
      rec.targetDoctors++;
      // Check if any visit for this entry used this item
      const visitedWithItem = (e.visits || []).some(v => v.itemId === it.id);
      if (visitedWithItem) rec.visitedDoctors++;
    }
  }
  const byItem = Array.from(itemMap.entries()).map(([name, d]) => ({
    name, targetDoctors: d.targetDoctors, visitedDoctors: d.visitedDoctors,
    pct: d.targetDoctors > 0 ? Math.round((d.visitedDoctors / d.targetDoctors) * 100) : 0,
  })).sort((a, b) => b.targetDoctors - a.targetDoctors);

  // Filter by area if requested
  let filteredArea = null;
  if (filters.areaName) {
    const areasList = await prisma.area.findMany({ where: userId ? { userId } : {}, select: { id: true, name: true }, take: 200 }).catch(() => []);
    const area = fuzzyFind(areasList, 'name', filters.areaName);
    if (area) filteredArea = byArea.find(a => a.name === area.name) || null;
  }

  // Filter by item if requested
  let filteredItem = null;
  if (filters.itemName) {
    const nq = norm(filters.itemName);
    filteredItem = byItem.find(i => norm(i.name) === nq)
      || byItem.find(i => norm(i.name).includes(nq) || nq.includes(norm(i.name)))
      || null;
  }

  return {
    found: true,
    type: 'plan_stats',
    month, year,
    repName: plan.scientificRep?.name || null,
    totalDoctors, visitedDoctors, doctorCoveragePct,
    totalTargetVisits, totalActualVisits, completionPct,
    byArea: filteredArea ? [filteredArea] : byArea,
    byItem: filteredItem ? [filteredItem] : byItem,
    filteredAreaName: filteredArea?.name || null,
    filteredItemName: filteredItem?.name || null,
  };
}

// ── Execute: Stats Summary ────────────────────────────────────
async function executeStatsQuery(spec, userId) {
  const { filters = {}, groupBy } = spec;
  const areasList = await prisma.area.findMany({
    where: userId ? { userId } : {},
    select: { id: true, name: true },
    take: 200,
  }).catch(() => []);

  const dateFilter = buildDateFilter(filters);
  const baseWhere = {};
  if (userId) baseWhere.userId = userId;

  // Area filter
  if (filters.areaName) {
    const area = fuzzyFind(areasList, 'name', filters.areaName);
    if (area) baseWhere.doctor = { areaId: area.id };
  }

  // Rep filter
  let repId = null;
  if (filters.repName) {
    const list = await prisma.scientificRepresentative.findMany({
      where: userId ? { userId } : {},
      select: { id: true, name: true },
    });
    const found = fuzzyFind(list, 'name', filters.repName);
    if (found) { repId = found.id; baseWhere.scientificRepId = found.id; }
  }

  // Item filter
  let itemId = null;
  if (filters.itemName) {
    const list = await prisma.item.findMany({
      where: userId ? { userId } : {},
      select: { id: true, name: true },
    });
    const found = fuzzyFind(list, 'name', filters.itemName);
    if (found) { itemId = found.id; baseWhere.itemId = found.id; }
  }

  if (dateFilter) baseWhere.visitDate = dateFilter;

  const visitType = filters.visitType || 'doctor';

  // Count doctor visits
  let doctorTotal = 0;
  let doctorByGroup = [];
  if (visitType !== 'pharmacy') {
    doctorTotal = await prisma.doctorVisit.count({ where: baseWhere }).catch(() => 0);

    if (groupBy === 'area') {
      const rows = await prisma.doctorVisit.groupBy({
        by: ['doctorId'],
        where: baseWhere,
        _count: { _all: true },
        orderBy: { _count: { doctorId: 'desc' } },
        take: 100,
      }).catch(() => []);
      // Aggregate by area
      const doctorIds = rows.map(r => r.doctorId);
      const doctors = await prisma.doctor.findMany({
        where: { id: { in: doctorIds } },
        include: { area: { select: { name: true } } },
      }).catch(() => []);
      const docMap = new Map(doctors.map(d => [d.id, d.area?.name || 'بدون منطقة']));
      const areaCount = new Map();
      for (const r of rows) {
        const aName = docMap.get(r.doctorId) || 'بدون منطقة';
        areaCount.set(aName, (areaCount.get(aName) || 0) + r._count._all);
      }
      doctorByGroup = Array.from(areaCount.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    } else if (groupBy === 'item') {
      const rows = await prisma.doctorVisit.groupBy({
        by: ['itemId'],
        where: baseWhere,
        _count: { _all: true },
        orderBy: { _count: { itemId: 'desc' } },
        take: 10,
      }).catch(() => []);
      const itemIds = rows.map(r => r.itemId).filter(Boolean);
      const items = await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } }).catch(() => []);
      const itemMap = new Map(items.map(i => [i.id, i.name]));
      doctorByGroup = rows.map(r => ({ key: itemMap.get(r.itemId) || 'بدون إيتم', count: r._count._all })).sort((a, b) => b.count - a.count);
    } else if (groupBy === 'rep') {
      const rows = await prisma.doctorVisit.groupBy({
        by: ['scientificRepId'],
        where: baseWhere,
        _count: { _all: true },
        orderBy: { _count: { scientificRepId: 'desc' } },
        take: 10,
      }).catch(() => []);
      const repIds = rows.map(r => r.scientificRepId).filter(Boolean);
      const reps = await prisma.scientificRepresentative.findMany({ where: { id: { in: repIds } }, select: { id: true, name: true } }).catch(() => []);
      const repMap = new Map(reps.map(r => [r.id, r.name]));
      doctorByGroup = rows.map(r => ({ key: repMap.get(r.scientificRepId) || 'غير محدد', count: r._count._all })).sort((a, b) => b.count - a.count);
    } else if (groupBy === 'feedback') {
      const rows = await prisma.doctorVisit.groupBy({
        by: ['feedback'],
        where: baseWhere,
        _count: { _all: true },
        orderBy: { _count: { feedback: 'desc' } },
      }).catch(() => []);
      doctorByGroup = rows.map(r => ({ key: FEEDBACK_AR[r.feedback] || r.feedback, count: r._count._all })).sort((a, b) => b.count - a.count);
    } else if (groupBy === 'date') {
      const visits = await prisma.doctorVisit.findMany({
        where: baseWhere,
        select: { visitDate: true },
        orderBy: { visitDate: 'asc' },
        take: 500,
      }).catch(() => []);
      const dateCount = new Map();
      for (const v of visits) {
        const d = new Date(v.visitDate);
        const key = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
        dateCount.set(key, (dateCount.get(key) || 0) + 1);
      }
      doctorByGroup = Array.from(dateCount.entries()).map(([key, count]) => ({ key, count }));
    } else {
      // Default: top 5 by area, item, rep
      const [byArea, byItem, byRep, byFeedback] = await Promise.all([
        prisma.doctorVisit.groupBy({ by: ['doctorId'], where: baseWhere, _count: { _all: true }, take: 200 }).catch(() => []),
        prisma.doctorVisit.groupBy({ by: ['itemId'], where: baseWhere, _count: { _all: true }, orderBy: { _count: { itemId: 'desc' } }, take: 5 }).catch(() => []),
        prisma.doctorVisit.groupBy({ by: ['scientificRepId'], where: baseWhere, _count: { _all: true }, orderBy: { _count: { scientificRepId: 'desc' } }, take: 5 }).catch(() => []),
        prisma.doctorVisit.groupBy({ by: ['feedback'], where: baseWhere, _count: { _all: true }, orderBy: { _count: { feedback: 'desc' } } }).catch(() => []),
      ]);

      // Enrich areas
      const dIds = byArea.map(r => r.doctorId);
      const docs = await prisma.doctor.findMany({ where: { id: { in: dIds } }, include: { area: { select: { name: true } } } }).catch(() => []);
      const dMap = new Map(docs.map(d => [d.id, d.area?.name || 'بدون منطقة']));
      const areaCountMap = new Map();
      for (const r of byArea) {
        const a = dMap.get(r.doctorId) || 'بدون منطقة';
        areaCountMap.set(a, (areaCountMap.get(a) || 0) + r._count._all);
      }
      const topAreas = Array.from(areaCountMap.entries()).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 5);

      // Enrich items
      const iIds = byItem.map(r => r.itemId).filter(Boolean);
      const items = await prisma.item.findMany({ where: { id: { in: iIds } }, select: { id: true, name: true } }).catch(() => []);
      const iMap = new Map(items.map(i => [i.id, i.name]));
      const topItems = byItem.map(r => ({ key: iMap.get(r.itemId) || 'بدون إيتم', count: r._count._all }));

      // Enrich reps
      const rIds = byRep.map(r => r.scientificRepId).filter(Boolean);
      const repsList = await prisma.scientificRepresentative.findMany({ where: { id: { in: rIds } }, select: { id: true, name: true } }).catch(() => []);
      const rMap = new Map(repsList.map(r => [r.id, r.name]));
      const topReps = byRep.map(r => ({ key: rMap.get(r.scientificRepId) || 'غير محدد', count: r._count._all }));

      const feedbackBreakdown = byFeedback.map(r => ({ key: FEEDBACK_AR[r.feedback] || r.feedback, count: r._count._all }));

      return {
        found: true,
        type: 'stats_summary',
        visitType: 'doctor',
        totalVisits: doctorTotal,
        topAreas,
        topItems,
        topReps,
        feedbackBreakdown,
      };
    }
  }

  // Pharmacy stats (if needed)
  let pharmTotal = 0;
  if (visitType === 'pharmacy' || visitType === 'all') {
    const pharmWhere = {};
    if (userId) pharmWhere.userId = userId;
    if (dateFilter) pharmWhere.visitDate = dateFilter;
    pharmTotal = await prisma.pharmacyVisit.count({ where: pharmWhere }).catch(() => 0);
  }

  return {
    found: true,
    type: 'stats_summary',
    visitType,
    totalVisits: doctorTotal + pharmTotal,
    doctorVisits: visitType !== 'pharmacy' ? doctorTotal : undefined,
    pharmacyVisits: visitType !== 'doctor' ? pharmTotal : undefined,
    breakdown: doctorByGroup,
    groupBy,
  };
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
  const { areaName, specialty, doctorName, pharmacyName } = filters;

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
    where.specialty = { contains: specialty, mode: 'insensitive' };
  }

  // Doctor name search (fuzzy)
  if (doctorName) {
    where.name = { contains: doctorName, mode: 'insensitive' };
  }

  // Pharmacy name search
  if (pharmacyName) {
    where.pharmacyName = { contains: pharmacyName, mode: 'insensitive' };
  }

  const doctors = await prisma.doctor.findMany({
    where,
    take: Math.min(Number(spec.limit) || 100, 200),
    include: { area: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });

  // Fuzzy fallback: if primary Prisma query returned 0 results
  let matched = doctors;
  if (doctors.length === 0 && (doctorName || pharmacyName || specialty)) {
    // Build a base query (area filter is already resolved to areaId)
    const baseWhere = { ...where };
    delete baseWhere.specialty;
    delete baseWhere.name;
    delete baseWhere.pharmacyName;
    const allDocs = await prisma.doctor.findMany({
      where: baseWhere,
      include: { area: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
    matched = allDocs.filter(d => {
      if (doctorName) {
        const n = norm(d.name), q = norm(doctorName);
        if (!(n.includes(q) || q.includes(n))) return false;
      }
      if (pharmacyName) {
        const n = norm(d.pharmacyName || ''), q = norm(pharmacyName);
        if (!(n && (n.includes(q) || q.includes(n)))) return false;
      }
      if (specialty) {
        const s = norm(d.specialty || ''), q = norm(specialty);
        if (!(s.includes(q) || q.includes(s))) return false;
      }
      return true;
    });
  }

  if (!matched.length) {
    return { found: false, message: 'لا يوجد أطباء يطابقون البحث' };
  }

  return {
    found: true,
    type: 'doctor_list',
    totalDoctors: matched.length,
    doctors: matched.map(d => ({
      name:      d.name,
      specialty: d.specialty || '',
      areaName:  d.area?.name || '',
      phone:     d.phone || '',
      pharmacyName: d.pharmacyName || '',
    })),
  };
}

// ── Commercial Rep: System Prompt ────────────────────────────
function buildCommercialSystemPrompt({ currentPage, pharmNames, areaNames }) {
  const now = new Date();
  const curDay = now.getDate(), curMonth = now.getMonth() + 1, curYear = now.getFullYear();
  const pharmsText = pharmNames.length ? pharmNames.join('، ') : 'لا يوجد';
  const areasText  = areaNames.length  ? areaNames.join('، ')  : 'لا يوجد';
  return `أنت مساعد ذكي لمندوب تجاري في تطبيق مبيعات صيدلانية. مهمتك: تحليل سؤال المندوب وإرجاع JSON دقيق.

الصفحة الحالية: ${currentPage}
التاريخ الآن: ${curDay}/${curMonth}/${curYear}

═══ البيانات المتاحة ═══
الصيدليات: ${pharmsText}
المناطق: ${areasText}

═══ مخطط قاعدة البيانات ═══
جدول CommercialInvoice (الفواتير):
  • invoiceDate, pharmacyName, areaName, status, totalAmount, collectedAmount, returnedAmount, paymentType

جدول CommercialInvoiceItem (أيتمات المبيعات):
  • brandName — الاسم التجاري للدواء
  • quantity — الكمية
  • bonusQty — كمية مجانية (بونص)
  • unitPrice, totalPrice
  • مرتبط بـ CommercialInvoice → pharmacyName, areaName, invoiceDate
  • مرتبط بـ Item → company.name (الشركة)

جدول CollectionRecord (الاسترجاعات والتحصيلات):
  • collectedAt — تاريخ الاسترجاع
  • returnedAmount — قيمة المسترجع
  • returnedItemsJson — تفاصيل الأيتمات المسترجعة
  • مرتبط بـ CommercialInvoice → pharmacyName, areaName, invoiceNumber

جدول Pharmacy (صيدليات السيرفي):
  • name, areaName, ownerName, phone, address, isActive
  • صيدليات المنطقة المخصصة للمندوب

═══ الإجراءات المتاحة ═══
1. query_invoices → استعلام الفواتير (حالة، مبالغ، تحصيل)
2. query_sales    → استعلام مبيعات الأيتمات (كميات، أسعار، شركات)
3. query_returns  → استعلام الاسترجاعات
4. query_survey   → استعلام صيدليات السيرفي في المناطق المخصصة
5. unknown        → طلب غير مفهوم

═══ فلاتر query_invoices ═══
pharmacyName, areaName, status(pending|partial|collected|open), paymentType(cash|deferred), month, year, day
groupBy: "pharmacy"|"area"|"status"|"date"|null

═══ فلاتر query_sales ═══
pharmacyName, areaName, brandName, month, year, day
groupBy: "brand"|"company"|"pharmacy"|"area"|"date"|null

═══ فلاتر query_returns ═══
pharmacyName, month, year, day

═══ فلاتر query_survey ═══
areaName, pharmacyName
groupBy: "area"|null

═══ قواعد ═══
• "مبيعات"/"مبيع"/"ايتمات"/"أدوية مباعة"/"كميات" → action:"query_sales"
• "ارجاع"/"استرجاع"/"مرتجع"/"مردود" → action:"query_returns"
• "سيرفي"/"صيدليات منطقتي"/"قائمة الصيدليات" → action:"query_survey"
• "فواتير"/"فاتورة"/"مديونية"/"استحصال"/"تحصيل" → action:"query_invoices"
• "غير مسددة"/"مديونية"/"مو مكتملة" → status:"open"
• "معلقة" → status:"pending" | "جزئية" → status:"partial" | "مكتملة"/"محصّلة" → status:"collected"
• "هذا الشهر" → month:${curMonth}, year:${curYear}
• "الشهر الماضي" → month:${curMonth === 1 ? 12 : curMonth - 1}, year:${curMonth === 1 ? curYear - 1 : curYear}
• "اليوم" → day:${curDay}, month:${curMonth}, year:${curYear}
• "حسب الصيدلية" → groupBy:"pharmacy" | "حسب المنطقة" → groupBy:"area"
• "حسب الشركة"/"حسب الدواء"/"حسب الإيتم" → groupBy:"company"|"brand"

═══ صيغة الرد (JSON فقط) ═══
{
  "action": "query_invoices" | "query_sales" | "query_returns" | "query_survey" | "unknown",
  "filters": {
    "pharmacyName": null,
    "areaName": null,
    "brandName": null,
    "status": null,
    "paymentType": null,
    "month": null,
    "year": null,
    "day": null
  },
  "groupBy": null,
  "limit": 100,
  "responseText": "جملة عربية تصف ما ستعرضه",
  "needsClarification": false,
  "question": ""
}`;
}

// ── Commercial Rep: Execute Invoice Query ─────────────────────
async function executeInvoiceQuery(spec, repId) {
  const { filters = {}, groupBy, limit } = spec;
  const where = { assignedRepId: repId };

  if (filters.pharmacyName) {
    where.pharmacyName = { contains: filters.pharmacyName };
  }
  if (filters.areaName) {
    where.areaName = { contains: filters.areaName };
  }
  if (filters.status) {
    if (filters.status === 'open') {
      where.status = { in: ['pending', 'partial'] };
    } else {
      where.status = filters.status;
    }
  }
  if (filters.paymentType) {
    where.paymentType = filters.paymentType;
  }

  // Date filter
  const now = new Date();
  const yr = filters.year || now.getFullYear();
  const mo = filters.month ?? null;
  const dy = filters.day   ?? null;
  if (dy !== null) {
    const m = mo !== null ? mo : now.getMonth() + 1;
    where.invoiceDate = { gte: new Date(yr, m - 1, dy, 0, 0, 0), lte: new Date(yr, m - 1, dy, 23, 59, 59) };
  } else if (mo !== null) {
    where.invoiceDate = { gte: new Date(yr, mo - 1, 1), lt: new Date(yr, mo, 1) };
  }

  const invoices = await prisma.commercialInvoice.findMany({
    where,
    orderBy: { invoiceDate: 'desc' },
    take: Math.min(Number(limit) || 100, 300),
    select: {
      id: true, invoiceNumber: true, invoiceDate: true,
      pharmacyName: true, areaName: true,
      status: true, paymentType: true,
      totalAmount: true, collectedAmount: true, returnedAmount: true, notes: true,
    },
  });

  if (!invoices.length) {
    return { found: false, message: 'لا توجد فواتير تطابق البحث' };
  }

  const STATUS_AR = { pending: 'معلق ⏳', partial: 'جزئي 🔄', collected: 'مكتمل ✅', open: 'غير مسدد' };
  const fmt = n => Number(n || 0).toLocaleString('ar-IQ-u-nu-latn', { maximumFractionDigits: 0 });

  const mapInv = inv => ({
    invoiceNumber:    inv.invoiceNumber,
    date:             inv.invoiceDate,
    pharmacyName:     inv.pharmacyName,
    areaName:         inv.areaName   || '—',
    status:           STATUS_AR[inv.status] || inv.status,
    paymentType:      inv.paymentType === 'cash' ? 'نقد' : 'آجل',
    totalAmount:      fmt(inv.totalAmount),
    collectedAmount:  fmt(inv.collectedAmount),
    remaining:        fmt((inv.totalAmount - inv.returnedAmount - inv.collectedAmount)),
    returnedAmount:   fmt(inv.returnedAmount || 0),
  });

  const totalVal      = invoices.reduce((s, i) => s + (i.totalAmount || 0), 0);
  const collectedVal  = invoices.reduce((s, i) => s + (i.collectedAmount || 0), 0);
  const remainingVal  = invoices.reduce((s, i) => s + (i.totalAmount - (i.returnedAmount || 0) - i.collectedAmount), 0);

  const summary = {
    totalInvoices: invoices.length,
    totalAmount:   fmt(totalVal),
    collected:     fmt(collectedVal),
    remaining:     fmt(remainingVal),
  };

  if (groupBy) {
    const grouped = new Map();
    for (const inv of invoices) {
      let key;
      if      (groupBy === 'pharmacy') key = inv.pharmacyName;
      else if (groupBy === 'area')     key = inv.areaName || 'بدون منطقة';
      else if (groupBy === 'status')   key = STATUS_AR[inv.status] || inv.status;
      else if (groupBy === 'date') {
        const d = new Date(inv.invoiceDate);
        key = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
      } else key = inv.pharmacyName;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(inv);
    }
    const groups = Array.from(grouped.entries()).map(([groupKey, invs]) => ({
      groupKey,
      count: invs.length,
      totalAmount:  fmt(invs.reduce((s, i) => s + (i.totalAmount || 0), 0)),
      collected:    fmt(invs.reduce((s, i) => s + (i.collectedAmount || 0), 0)),
      remaining:    fmt(invs.reduce((s, i) => s + (i.totalAmount - (i.returnedAmount || 0) - i.collectedAmount), 0)),
      invoices: invs.map(mapInv),
    })).sort((a, b) => b.count - a.count);
    return { found: true, type: 'invoices_grouped', groupBy, summary, groups };
  }

  return { found: true, type: 'invoices_list', summary, invoices: invoices.map(mapInv) };
}

// ── Commercial Rep: Execute Sales (Invoice Items) Query ───────
async function executeSalesQuery(spec, repId) {
  const { filters = {}, groupBy, limit } = spec;

  const invoiceWhere = { assignedRepId: repId };
  if (filters.areaName)     invoiceWhere.areaName     = { contains: filters.areaName };
  if (filters.pharmacyName) invoiceWhere.pharmacyName = { contains: filters.pharmacyName };

  const now = new Date();
  const yr = filters.year || now.getFullYear();
  const mo = filters.month ?? null;
  const dy = filters.day   ?? null;
  if (dy !== null) {
    const m = mo !== null ? mo : now.getMonth() + 1;
    invoiceWhere.invoiceDate = { gte: new Date(yr, m - 1, dy, 0, 0, 0), lte: new Date(yr, m - 1, dy, 23, 59, 59) };
  } else if (mo !== null) {
    invoiceWhere.invoiceDate = { gte: new Date(yr, mo - 1, 1), lt: new Date(yr, mo, 1) };
  }

  const itemWhere = { invoice: invoiceWhere };
  if (filters.brandName) itemWhere.brandName = { contains: filters.brandName };

  const items = await prisma.commercialInvoiceItem.findMany({
    where: itemWhere,
    take: Math.min(Number(limit) || 150, 300),
    orderBy: { totalPrice: 'desc' },
    include: {
      invoice: { select: { pharmacyName: true, areaName: true, invoiceDate: true } },
      item:    { select: { company: { select: { name: true } } } },
    },
  });

  if (!items.length) return { found: false, message: 'لا توجد مبيعات تطابق البحث' };

  const fmt = n => Number(n || 0).toLocaleString('ar-IQ-u-nu-latn', { maximumFractionDigits: 0 });
  const mapItem = it => ({
    brandName:    it.brandName,
    company:      it.item?.company?.name || '—',
    quantity:     it.quantity || 0,
    bonusQty:     it.bonusQty || 0,
    unitPrice:    fmt(it.unitPrice),
    totalPrice:   fmt(it.totalPrice),
    pharmacyName: it.invoice?.pharmacyName || '—',
    areaName:     it.invoice?.areaName || '—',
    date:         it.invoice?.invoiceDate,
  });

  const totalQty   = items.reduce((s, i) => s + (i.quantity || 0), 0);
  const totalValue = items.reduce((s, i) => s + (i.totalPrice || 0), 0);
  const summary = { totalLines: items.length, totalQty, totalValue: fmt(totalValue) };

  if (groupBy) {
    const grouped = new Map();
    for (const it of items) {
      let key;
      if      (groupBy === 'brand')    key = it.brandName;
      else if (groupBy === 'company')  key = it.item?.company?.name || 'غير محدد';
      else if (groupBy === 'pharmacy') key = it.invoice?.pharmacyName || '—';
      else if (groupBy === 'area')     key = it.invoice?.areaName || 'بدون منطقة';
      else if (groupBy === 'date') {
        const d = new Date(it.invoice?.invoiceDate);
        key = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
      } else key = it.brandName;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(it);
    }
    const groups = Array.from(grouped.entries()).map(([groupKey, its]) => ({
      groupKey,
      totalQty:   its.reduce((s, i) => s + (i.quantity || 0), 0),
      totalValue: fmt(its.reduce((s, i) => s + (i.totalPrice || 0), 0)),
      items: its.map(mapItem),
    })).sort((a, b) => b.totalQty - a.totalQty);
    return { found: true, type: 'sales_grouped', groupBy, summary, groups };
  }

  return { found: true, type: 'sales_list', summary, items: items.map(mapItem) };
}

// ── Commercial Rep: Execute Returns Query ─────────────────────
async function executeReturnsQuery(spec, repId) {
  const { filters = {}, limit } = spec;
  const where = { collectedById: repId, returnedAmount: { gt: 0 } };

  const now = new Date();
  const yr = filters.year || now.getFullYear();
  const mo = filters.month ?? null;
  const dy = filters.day   ?? null;
  if (dy !== null) {
    const m = mo !== null ? mo : now.getMonth() + 1;
    where.collectedAt = { gte: new Date(yr, m - 1, dy, 0, 0, 0), lte: new Date(yr, m - 1, dy, 23, 59, 59) };
  } else if (mo !== null) {
    where.collectedAt = { gte: new Date(yr, mo - 1, 1), lt: new Date(yr, mo, 1) };
  }

  const records = await prisma.collectionRecord.findMany({
    where,
    take: Math.min(Number(limit) || 100, 300),
    orderBy: { collectedAt: 'desc' },
    include: { invoice: { select: { pharmacyName: true, areaName: true, invoiceNumber: true } } },
  });

  if (!records.length) return { found: false, message: 'لا توجد استرجاعات تطابق البحث' };

  let filtered = records;
  if (filters.pharmacyName) {
    const q = filters.pharmacyName.toLowerCase();
    filtered = records.filter(r => r.invoice?.pharmacyName?.toLowerCase().includes(q));
    if (!filtered.length) return { found: false, message: `لا توجد استرجاعات لصيدلية "${filters.pharmacyName}"` };
  }

  const fmt = n => Number(n || 0).toLocaleString('ar-IQ-u-nu-latn', { maximumFractionDigits: 0 });
  const totalReturned = filtered.reduce((s, r) => s + (r.returnedAmount || 0), 0);
  const summary = { totalRecords: filtered.length, totalReturned: fmt(totalReturned) };

  const mapRecord = r => {
    let returnedItems = [];
    try { returnedItems = JSON.parse(r.returnedItemsJson || '[]'); } catch { /* ignore */ }
    return {
      date:           r.collectedAt,
      pharmacyName:   r.invoice?.pharmacyName || '—',
      areaName:       r.invoice?.areaName || '—',
      invoiceNumber:  r.invoice?.invoiceNumber || '—',
      returnedAmount: fmt(r.returnedAmount),
      notes:          r.notes || '',
      returnedItems,
    };
  };

  return { found: true, type: 'returns_list', summary, records: filtered.map(mapRecord) };
}

// ── Commercial Rep: Execute Survey Pharmacies Query ───────────
async function executeSurveyQuery(spec, repId) {
  const { filters = {}, groupBy, limit } = spec;

  const areaAssignments = await prisma.userAreaAssignment.findMany({
    where: { userId: repId },
    include: { area: { select: { id: true, name: true } } },
  });
  const allAreaIds = areaAssignments.map(a => a.areaId);

  // Area name filter
  let filteredAreaIds = null;
  if (filters.areaName) {
    const q = filters.areaName.toLowerCase();
    const matched = areaAssignments.filter(a => a.area?.name?.toLowerCase().includes(q));
    if (!matched.length) return { found: false, message: `لا توجد منطقة "${filters.areaName}" في تعيينات المندوب` };
    filteredAreaIds = matched.map(a => a.areaId);
  }

  const areaIds = filteredAreaIds ?? allAreaIds;
  const where = {
    isActive: true,
    OR: [
      ...(areaIds.length > 0 ? [{ areaId: { in: areaIds } }] : []),
      { userId: repId },
    ],
  };
  if (filters.pharmacyName) where.name = { contains: filters.pharmacyName };

  const pharmacies = await prisma.pharmacy.findMany({
    where,
    take: Math.min(Number(limit) || 200, 500),
    include: { area: { select: { name: true } } },
    orderBy: [{ areaId: 'asc' }, { name: 'asc' }],
  });

  if (!pharmacies.length) return { found: false, message: 'لا توجد صيدليات سيرفي مطابقة' };

  const mapPharm = p => ({
    name:      p.name,
    areaName:  p.area?.name || p.areaName || '—',
    ownerName: p.ownerName || '',
    phone:     p.phone || '',
    address:   p.address || '',
    notes:     p.notes || '',
  });

  const summary = { totalPharmacies: pharmacies.length };

  if (groupBy === 'area') {
    const grouped = new Map();
    for (const p of pharmacies) {
      const key = p.area?.name || p.areaName || 'بدون منطقة';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(p);
    }
    const groups = Array.from(grouped.entries()).map(([areaName, ps]) => ({
      areaName, count: ps.length, pharmacies: ps.map(mapPharm),
    }));
    return { found: true, type: 'survey_grouped', summary, groups };
  }

  return { found: true, type: 'survey_list', summary, pharmacies: pharmacies.map(mapPharm) };
}

// ── Execute: Dispatch ─────────────────────────────────────────
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
    const userRole = context.userRole || req.user?.role || 'user';
    const isCommercialRep = userRole === 'commercial_rep';

    // ── Commercial Rep branch ────────────────────────────────
    if (isCommercialRep) {
      const [pharmsRaw, areasRaw] = await Promise.all([
        prisma.commercialInvoice.findMany({
          where: { assignedRepId: userId },
          select: { pharmacyName: true },
          distinct: ['pharmacyName'],
          take: 80,
        }).catch(() => []),
        prisma.userAreaAssignment.findMany({
          where: { userId },
          include: { area: { select: { name: true } } },
          take: 40,
        }).catch(() => []),
      ]);

      const pharmNames = pharmsRaw.map(p => p.pharmacyName);
      const areaNames  = areasRaw.map(a => a.area?.name).filter(Boolean);

      const systemPrompt = buildCommercialSystemPrompt({
        currentPage: context.currentPage || 'الفواتير',
        pharmNames, areaNames,
      });

      async function callGeminiComm(parts, retries = 5, delayMs = 1000) {
        let lastErr;
        for (let attempt = 1; attempt <= retries; attempt++) {
          const key = getNextApiKey();
          console.log(`[ai-assistant] callGeminiComm attempt ${attempt}/${retries}, key prefix: ${key?.slice(0,8)}`);
          const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-2.0-flash' });
          try {
            const result = await model.generateContent(parts);
            return result.response.text();
          } catch (err) {
            lastErr = err;
            console.error(`[ai-assistant] Gemini comm error attempt ${attempt}:`, err?.message || err);
            const is429 = String(err?.message || '').includes('429') || err?.status === 429;
            if (is429 && attempt < retries) await new Promise(r => setTimeout(r, delayMs * attempt));
            else throw err;
          }
        }
        throw lastErr;
      }

      let geminiText;
      if (hasAudio) {
        const audioData = fs.readFileSync(req.file.path);
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
        geminiText = await callGeminiComm([
          systemPrompt,
          { inlineData: { mimeType: req.file.mimetype || 'audio/webm', data: audioData.toString('base64') } },
          'استمع للتسجيل وأرجع JSON فقط.',
        ]);
      } else {
        geminiText = await callGeminiComm([
          systemPrompt,
          `أمر المستخدم: "${textInput}"\nأرجع JSON فقط.`,
        ]);
      }

      const jsonMatch = geminiText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(422).json({ success: false, error: 'تعذر تحليل رد Gemini', raw: geminiText });
      let parsed;
      try { parsed = JSON.parse(jsonMatch[0]); }
      catch { return res.status(422).json({ success: false, error: 'JSON غير صالح', raw: geminiText }); }

      let queryResult = null;
      if      (parsed.action === 'query_invoices') queryResult = await executeInvoiceQuery(parsed, userId);
      else if (parsed.action === 'query_sales')    queryResult = await executeSalesQuery(parsed, userId);
      else if (parsed.action === 'query_returns')  queryResult = await executeReturnsQuery(parsed, userId);
      else if (parsed.action === 'query_survey')   queryResult = await executeSurveyQuery(parsed, userId);

      return res.json({ success: true, data: { ...parsed, navigatePage: null, pageAction: null, pageActionParam: null, queryResult } });
    }
    // ── End Commercial Rep branch ────────────────────────────

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

    let geminiText;

    // ── Retry helper: rotate API key on each attempt on 429 ──
    async function callGemini(parts, retries = 5, delayMs = 1000) {
      let lastErr;
      for (let attempt = 1; attempt <= retries; attempt++) {
        const key = getNextApiKey();
        console.log(`[ai-assistant] callGemini attempt ${attempt}/${retries}, key prefix: ${key?.slice(0,8)}`);
        const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-2.0-flash' });
        try {
          const result = await model.generateContent(parts);
          return result.response.text();
        } catch (err) {
          lastErr = err;
          console.error(`[ai-assistant] Gemini error attempt ${attempt}:`, err?.message || err);
          const is429 = String(err?.message || '').includes('429') || err?.status === 429;
          if (is429 && attempt < retries) {
            await new Promise(r => setTimeout(r, delayMs * attempt));
          } else {
            throw err;
          }
        }
      }
      throw lastErr;
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
    } else if (parsed.action === 'query_stats') {
      queryResult = await executeStatsQuery(parsed, userId);
    } else if (parsed.action === 'query_plan_stats') {
      queryResult = await executePlanStatsQuery(parsed, userId);
    }

    const validPages = ['dashboard','upload','representatives','scientific-reps','doctors','monthly-plans','reports','users','rep-analysis'];
    const navigatePage = (parsed.action === 'navigate' && validPages.includes(parsed.navigatePage))
      ? parsed.navigatePage : null;

    const validPageActions = [
      'open-suggest-settings', 'open-new-plan', 'open-import-visits', 'open-plan',
      'open-add-doctor', 'open-import-doctors', 'open-coverage', 'open-wish-list',
      'open-add-sci-rep', 'open-add-rep', 'open-add-user',
      'open-call-log', 'open-voice-call', 'open-map', 'open-export-report',
      'fill-visit-form', 'fill-pharmacy-visit', 'open-wish-list-area', 'open-doctors-area',
    ];
    const pageAction = (parsed.action === 'page_action' && validPageActions.includes(parsed.pageAction))
      ? parsed.pageAction : null;
    const pageActionParam = pageAction ? (parsed.pageActionParam ?? null) : null;

    return res.json({ success: true, data: { ...parsed, navigatePage, pageAction, pageActionParam, queryResult } });

  } catch (err) {
    console.error('[ai-assistant] FINAL error:', err?.message || err, '| status:', err?.status);
    const msg = String(err?.message || '');
    const is429 = msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('quota') || msg.includes('Quota');
    const friendly = `Gemini Error: ${msg.slice(0, 400) || 'خطأ غير متوقع'}`;
    return res.status(is429 ? 429 : 500).json({ success: false, error: friendly });
  }
}
