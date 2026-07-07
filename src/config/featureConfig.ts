// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  المصدر الوحيد للحقيقة لصفحات الشريط الجانبي (Sidebar) وشجرة صلاحيات      ║
// ║  المستخدمين (Super Admin → المميزات).                                    ║
// ║                                                                          ║
// ║  Sidebar.tsx يستورد NAV_ITEMS و FEATURE_PAGE_MAP من هنا مباشرة —         ║
// ║  فأي صفحة تُضاف هنا تظهر تلقائياً في القائمة الجانبية الحقيقية وفي شاشة  ║
// ║  «المميزات» عند الأدمن، بنفس الاسم والأيقونة وترتيب الظهور، دون الحاجة   ║
// ║  لتكرار كتابتها في مكانين.                                               ║
// ║                                                                          ║
// ║  ما لا يزال يدوياً: الميزات الفرعية (تبويبات/أزرار داخل صفحة) — أضفها    ║
// ║  إلى PAGE_CHILDREN[pageId] عند إنشائها، ثم أغلقها في مكانها بـ           ║
// ║  hasFeature('key'). لو نسيت، ستحصل على تحذير في console (وضع dev فقط)   ║
// ║  لأن ALL_FEATURE_KEYS المُصدَّرة من هنا تُستخدم للتحقق من كل مفتاح يُمرَّر ║
// ║  إلى hasFeature() في AuthContext.                                       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export interface NavItemDef {
  id: string;
  labelAr: string;
  i18nKey?: 'dashboard' | 'doctors' | 'monthlyPlans' | 'dailyPlan' | 'reports' | 'users';
  icon: string;
  /** [] = مرئية لكل الأدوار */
  roles: string[];
}

// نفس القائمة التي تُبنى منها القائمة الجانبية الحقيقية للمستخدم (Sidebar.tsx)
export const NAV_ITEMS: NavItemDef[] = [
  { id: 'dashboard',         labelAr: 'الرئيسية',                  i18nKey: 'dashboard',    icon: '📊', roles: [] },
  { id: 'rep-analysis',      labelAr: 'تحليل ملفات المندوبين',      icon: '📂', roles: ['scientific_rep','team_leader','supervisor','company_manager','admin','manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user'] },
  { id: 'doctors',           labelAr: 'تحليل الكولات',              i18nKey: 'doctors',      icon: '🏥', roles: [] },
  { id: 'monthly-plans',     labelAr: 'البلان الشهري',              i18nKey: 'monthlyPlans', icon: '📅', roles: [] },
  { id: 'daily-plan',        labelAr: 'البلان اليومي',              i18nKey: 'dailyPlan',    icon: '📆', roles: ['scientific_rep','team_leader','supervisor','company_manager','admin','manager','user'] },
  { id: 'master-survey',     labelAr: 'سيرفي اوردين',               icon: '🗂️', roles: [] },
  { id: 'fms',               labelAr: 'FMS — عينات شهرية',         icon: '🧪', roles: ['company_manager','admin','manager'] },
  { id: 'sales-data',        labelAr: 'Stock',                      icon: '📊', roles: [] },
  { id: 'distributor-sales', labelAr: 'تحليل الموزعين',             icon: '📦', roles: [] },
  { id: 'file-filter',       labelAr: 'تنقية الملفات',              icon: '🗂️', roles: ['admin','manager','company_manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user'] },
  { id: 'pharmacy-analysis', labelAr: 'Pharmacy Net',                icon: '🔬', roles: ['admin','manager','company_manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user','scientific_rep','supervisor','team_leader'] },
  { id: 'bonus-sales',       labelAr: 'Bonus',                      icon: '🎁', roles: ['admin','manager','company_manager','team_leader','commercial_team_leader','commercial_supervisor','office_manager','scientific_rep','commercial_rep'] },
  { id: 'reports',           labelAr: 'التقارير',                   i18nKey: 'reports',      icon: '📋', roles: ['admin','manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user'] },
  { id: 'users',             labelAr: 'المستخدمين',                 i18nKey: 'users',        icon: '👥', roles: ['admin','manager','company_manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user','scientific_rep','team_leader','supervisor'] },
  { id: 'commercial',        labelAr: 'التجاري',                    icon: '💰', roles: ['commercial_rep','commercial_team_leader','commercial_supervisor','office_manager','admin','manager'] },
  { id: 'org-structure',     labelAr: 'الهيكلية',                   icon: '🏗️', roles: ['company_manager','admin','manager','office_manager','supervisor','product_manager','team_leader','commercial_supervisor','commercial_team_leader'] },
];

// مفتاح ميزة ← يخفي هذا المفتاح صفحة كاملة عند تعطيله (يمكن لعدة مفاتيح أن تشير لنفس الصفحة)
export const FEATURE_PAGE_MAP: Record<string, string> = {
  monthly_plans:      'monthly-plans',
  daily_plans:        'daily-plan',
  reports:            'reports',
  rep_analysis:       'rep-analysis',
  rep_files:          'rep-analysis',
  users_list:         'users',
  master_survey:      'master-survey',
  free_samples:       'fms',
  distributor_sales:  'distributor-sales',
  sales_data:         'sales-data',
  file_filter:        'file-filter',
  bonus_sales:        'bonus-sales',
};

// وصف كل صفحة يظهر للأدمن في شاشة المميزات
export const PAGE_DESCRIPTIONS: Record<string, string> = {
  'dashboard':         'الشاشة الرئيسية — متاحة دائماً لجميع المستخدمين',
  'rep-analysis':      'صفحة رفع وتحليل ملفات بيانات المندوبين',
  'doctors':           'صفحة إدارة الأطباء والزيارات (قائمة السيرفي) — متاحة لجميع الأدوار',
  'monthly-plans':     'صفحة إنشاء وإدارة البلانات الشهرية',
  'daily-plan':        'صفحة البلان اليومي — جدولة ومتابعة الزيارات اليومية',
  'master-survey':     'صفحة سيرفي اوردين — الاطلاع على قوائم الأطباء والصيدليات المركزية',
  'fms':               'صفحة إدارة العينات المجانية الشهرية الموزعة على الأطباء',
  'sales-data':        'صفحة تحليل ستوكات المخازن — رفع ملفات Excel وعرض الجداول والتحليل',
  'distributor-sales': 'رفع وتحليل ملفات Excel بتنسيق امازون / فريق — شهر3 / شهر4 / اعادة الفوترة',
  'file-filter':       'صفحة تنقية وتنظيف ملفات Excel وحذف الصفوف المكررة أو غير الصالحة',
  'pharmacy-analysis': 'صفحة Pharmacy Net — تحليل شامل لشبكة الصيدليات والإيتمات مقارنة بمبيعات المندوبين',
  'bonus-sales':       'رفع ملفات مبيعات البونص ومقارنتها بملفات التعويضات — مع تتبع تسليم البونص للصيدليات',
  'reports':           'صفحة عرض التقارير والإحصائيات',
  'users':             'صفحة عرض وإدارة قائمة المستخدمين',
  'commercial':        'صفحة التجاري — متابعة مبيعات وزيارات المندوبين التجاريين',
  'org-structure':     'صفحة الهيكلية — عرض الهيكل التنظيمي للمكتب/الشركة',
};

// ── مجموعات أدوار يُعاد استخدامها في تقييد ميزات فرعية معيّنة ──────────────
export const COMMERCIAL_ROLES = ['commercial_rep','commercial_team_leader','commercial_supervisor','admin','manager','office_manager','company_manager'];
export const REP_ROLES        = ['scientific_rep','team_leader','supervisor','admin','manager','company_manager','product_manager','office_manager'];
const ITEM_DEEP_ANALYSIS_ROLES = ['company_manager','admin','manager','product_manager','office_manager','team_leader','supervisor','commercial_supervisor','commercial_team_leader'];

export interface FeatureNode {
  key?:       string;
  label:      string;
  icon:       string;
  desc?:      string;
  onlyRoles?: string[];
  children?:  FeatureNode[];
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  MANDATORY RULE — الميزات الفرعية (تبويب/زر/حقل داخل صفحة موجودة)        ║
// ║  أضفها هنا في PAGE_CHILDREN[pageId] فوراً بـ key عربي ووصف وأيقونة،      ║
// ║  ثم أغلقها في المكوّن المناسب عبر: hasFeature('key')                    ║
// ║  (الصفحات نفسها — الخانة الأم — لا تحتاج أي إضافة يدوية: تُشتق تلقائياً  ║
// ║  من NAV_ITEMS أعلاه بمجرد إضافتها إلى الشريط الجانبي الحقيقي)            ║
// ╚══════════════════════════════════════════════════════════════════════════╝
export const PAGE_CHILDREN: Record<string, FeatureNode[]> = {
  'dashboard': [
    { key: 'call_log',    label: 'سجل إضافة الزيارات',    icon: '📝', desc: 'نموذج تسجيل الزيارة اليومية وإدخال البيانات' },
    { key: 'voice_visit', label: 'الزيارة الصوتية',         icon: '🎤', desc: 'زر تسجيل الزيارة عبر الصوت (الميكروفون)'     },
    { key: 'daily_map',   label: 'خريطة الزيارات اليومية',  icon: '🗺️', desc: 'عرض مواقع الزيارات على الخريطة التفاعلية'   },
  ],
  'doctors': [
    { key: 'visit_analysis_tab', label: 'تحليل الزيارات',           icon: '📍', desc: 'تبويب تحليل أداء الزيارات اليومية'               },
    { key: 'doctors_list_tab',   label: 'قائمة الأطباء',             icon: '📋', desc: 'تبويب عرض وإدارة قائمة الأطباء'                 },
    { key: 'archive_tab',        label: 'أرشيف السيرفي',             icon: '📚', desc: 'تبويب أرشيف يدوي مستقل لتتبع أطباء السيرفي'    },
    { key: 'my_visits_tab',      label: 'زياراتي',                  icon: '📝', desc: 'تبويب زيارات المندوب التجاري', onlyRoles: COMMERCIAL_ROLES },
    { key: 'pharmacies_tab',     label: 'قائمة الصيدليات',           icon: '🏪', desc: 'تبويب قائمة الصيدليات',        onlyRoles: COMMERCIAL_ROLES },
    { key: 'doctor_fields',      label: 'الحقول التفصيلية للطبيب',  icon: '🩺', desc: 'التخصص والمنطقة والصيدلية والملاحظات'          },
  ],
  'monthly-plans': [
    { key: 'wish_list', label: 'قائمة الطلبات', icon: '📋', desc: 'قائمة الأطباء المطلوب زيارتهم بالأولوية ضمن البلان الشهري' },
  ],
  'rep-analysis': [
    { key: 'rep_files',        label: 'رفع وعرض الملفات',          icon: '📤', desc: 'رفع ملفات Excel وعرض نتائج التحليل', onlyRoles: REP_ROLES },
    { key: 'currency_convert', label: 'تحويل العملة في التحليل',    icon: '💱', desc: 'تحويل أسعار الملفات من الدينار إلى الدولار عند التحليل — يُضبط لكل ملف على حدة', onlyRoles: REP_ROLES },
    { key: 'targets_tab',      label: 'التارگت الشهري',             icon: '🎯', desc: 'تبويب إدارة التارگت الشهري للمندوبين ومقارنته بالمبيعات' },
  ],
  'reports': [
    { key: 'export_report', label: 'تصدير التقارير', icon: '⬇️', desc: 'إمكانية تصدير وطباعة التقارير' },
  ],
  'bonus-sales': [
    { key: 'bonus_sales_upload',   label: 'رفع ملف المبيعات',       icon: '📤', desc: 'رفع ملف Excel للمبيعات الأساسي' },
    { key: 'bonus_comp_upload',    label: 'رفع ملف التعويضات',      icon: '📎', desc: 'رفع ملف التعويضات ومطابقته مع المبيعات' },
    { key: 'bonus_delivery_mark',  label: 'تأشير تسليم البونص',     icon: '✓',  desc: 'تأشير تسليم البونص للصيدلية من قبل المندوب' },
    { key: 'bonus_assign_auto',    label: 'توزيع بونص تلقائي',      icon: '🤖', desc: 'توزيع صفوف البونص تلقائياً على المندوبين بحسب المناطق' },
    { key: 'bonus_assign_manual',  label: 'توزيع بونص يدوي',        icon: '🗂', desc: 'تعيين صفوف أو مناطق بونص يدوياً لمندوب محدد' },
    { key: 'bonus_my_rows',        label: 'بونصاتي (مندوب)',        icon: '🎁', desc: 'عرض قائمة البونصات المعيَّنة للمندوب الحالي' },
  ],
  'sales-data': [
    { key: 'sales_data_upload',    label: 'رفع ملف / استيراد',           icon: '📥', desc: 'زر استيراد ملف Excel جديد وإضافته للقائمة'            },
    { key: 'sales_data_delete',    label: 'حذف الملف',                    icon: '🗑️', desc: 'حذف الملف من القائمة والخادم'                          },
    { key: 'sales_data_merge',     label: 'دمج الملفات',                  icon: '🔗', desc: 'دمج ملفين أو أكثر في ملف موحد'                         },
    { key: 'sales_data_export',    label: 'تصدير (Excel / Word / صورة)', icon: '⬇️', desc: 'قائمة تصدير الجدول بصيغ Excel وWord والصورة'          },
    { key: 'sales_data_shortage',  label: 'رادار النقص',                  icon: '🔴', desc: 'عرض الأصناف الناقصة أو المنعدمة في المخازن'            },
    { key: 'sales_data_classify',  label: 'تصنيف المذاخر (A/B/C)',       icon: '🏷️', desc: 'رفع ملف تصنيف المذاخر وتفعيل ألوان A/B/C على الجدول'  },
    { key: 'sales_data_value',     label: 'عرض القيمة المالية',           icon: '💰', desc: 'زر تبديل عرض الكميات ↔ القيم المالية'                 },
    { key: 'sales_data_analysis',  label: 'تبويب التحليل',               icon: '📈', desc: 'تبويب التحليل البياني حسب المنطقة والمخزن'             },
  ],
  'pharmacy-analysis': [
    {
      key: 'item_deep_analysis', label: 'تحليل الإيتم المعمّق (AI)', icon: '🔍',
      desc: 'تبويب داخل Pharmacy Net — تحليل ذكي شامل لأي إيتم: المبيع، الإرجاعات، المناطق، المندوبين، زيارات الأطباء والصيدليات، الفيدباك + توصيات Gemini',
      onlyRoles: ITEM_DEEP_ANALYSIS_ROLES,
    },
  ],
};

// ميزات عامة غير مرتبطة بصفحة واحدة محددة (زر عائم، زر في تذييل الشريط الجانبي...)
export const STANDALONE_FEATURES: FeatureNode[] = [
  { key: 'ai_assistant',    label: 'مساعد الذكاء الاصطناعي',        icon: '🤖', desc: 'الزر العائم للأوامر الصوتية والنصية الذكية — متاح في كل الصفحات' },
  { key: 'switch_account',  label: 'تبديل الحساب (Switch Account)', icon: '⇄',  desc: 'زر في الشريط الجانبي لتبديل الحسابات المحفوظة بدون تسجيل خروج' },
];

// ── يُبنى تلقائياً: خانة أم لكل صفحة حقيقية في NAV_ITEMS + ميزاتها الفرعية اليدوية ──
function buildFeatureTree(): FeatureNode[] {
  const keyByPageId: Record<string, string> = {};
  for (const [featKey, pageId] of Object.entries(FEATURE_PAGE_MAP)) {
    // إن وُجد أكثر من مفتاح لنفس الصفحة، يُستخدم أول مفتاح (عادة الأساسي) كخانة أم
    if (!keyByPageId[pageId]) keyByPageId[pageId] = featKey;
  }

  const pageNodes: FeatureNode[] = NAV_ITEMS.map(item => ({
    key:       keyByPageId[item.id],
    label:     item.labelAr,
    icon:      item.icon,
    desc:      PAGE_DESCRIPTIONS[item.id],
    onlyRoles: item.roles.length ? item.roles : undefined,
    children:  PAGE_CHILDREN[item.id],
  }));

  return [...pageNodes, ...STANDALONE_FEATURES];
}

export const FEATURE_TREE: FeatureNode[] = buildFeatureTree();

// عند هذا الدور، يُعاد ترتيب صفحاته: التجاري أولاً، ثم الرئيسية، ثم تحليل الكولات
// (نفس منطق إعادة الترتيب المستخدم فعلياً في Sidebar.tsx لهذا الدور)
export const COMM_REP_ORDER = ['commercial', 'dashboard', 'doctors'];

/**
 * صفحات NAV_ITEMS مرئية لهذا الدور، بنفس ترتيب ظهورها الحقيقي في الشريط الجانبي —
 * تُستخدم في شاشة «المميزات» عند الأدمن لعرض صفحات المستخدم كما تظهر فعلياً في حسابه.
 */
export function getVisiblePageNodes(role: string): { node: FeatureNode; pageId: string }[] {
  const withId = NAV_ITEMS.map((item, i) => ({ node: FEATURE_TREE[i], pageId: item.id, roles: item.roles }));
  const filtered = withId.filter(x => x.roles.length === 0 || x.roles.includes(role));
  if (role !== 'commercial_rep') return filtered;
  return [...filtered].sort((a, b) => {
    const ai = COMM_REP_ORDER.indexOf(a.pageId);
    const bi = COMM_REP_ORDER.indexOf(b.pageId);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

// كل مفاتيح الميزات المعروفة (لصفحة أم أو فرعية) — تُستخدم للتحقق وقت التطوير من أن
// كل استدعاء hasFeature('key') له مقابل مُسجَّل في شاشة المميزات عند الأدمن.
function collectKeys(nodes: FeatureNode[], out: Set<string>) {
  for (const n of nodes) {
    if (n.key) out.add(n.key);
    if (n.children) collectKeys(n.children, out);
  }
}
export const ALL_FEATURE_KEYS: Set<string> = (() => {
  const s = new Set<string>();
  collectKeys(FEATURE_TREE, s);
  return s;
})();
