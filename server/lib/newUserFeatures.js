// ════════════════════════════════════════════════════════════════════════════
// newUserFeatures.js — مميزات أي حساب جديد: كلها مطفأة عدا الرئيسية والكولات اليومية
// وطلبيات المذاخر، ويفعّل السوبر أدمن الباقي لكل حساب من «المميزات».
//
// مرآة لمفاتيح src/config/featureConfig.ts: ميزة عادية جديدة تكون مفعّلة ما لم تُذكر
// هنا. npm run test:new-user-features يفشل إن نُسي مفتاح.
// ════════════════════════════════════════════════════════════════════════════

/** ميزات عادية تبقى مفعّلة. سجل الزيارة وخريطتها جزء من صفحة الكولات اليومية. */
export const NEW_USER_KEPT_FEATURES = ['home_page', 'dashboard_page', 'call_log', 'daily_map'];

/** ميزات اشتراك (OPT_IN_FEATURES) تُفعَّل صراحةً؛ بقية ميزات الاشتراك مطفأة أصلاً. */
export const NEW_USER_ENABLED_OPT_IN = ['rep_orders'];

export const NEW_USER_DISABLED_FEATURES = [
  // صفحات
  'monthly_plans', 'daily_plans', 'reports', 'rep_analysis', 'rep_files', 'users_list',
  'master_survey', 'rep_field_survey', 'free_samples', 'distributor_sales', 'sales_data',
  'stock_ledger', 'stock_flow', 'file_filter', 'bonus_sales', 'doctors_page', 'pharmacy_analysis',
  'item_deep_analysis', 'account_builder', 'commercial_page', 'org_structure', 'aqdar_export',
  'team_engagement', 'rep_followup', 'motivation_page', 'province_teams',
  // تحليل الكولات
  'visit_analysis_tab', 'doctors_list_tab', 'archive_tab', 'my_visits_tab', 'pharmacies_tab', 'doctor_fields', 'visits_import',
  // البلان الشهري والتقارير
  'wish_list', 'export_report',
  // تحليل المبيعات
  'currency_convert', 'targets_tab', 'manual_sales_entry', 'bot_invoice_condition', 'bot_orders_review',
  'warehouse_gap_import', 'province_condition_import',
  // Bonus
  'bonus_sales_upload', 'bonus_comp_upload', 'bonus_delivery_mark', 'bonus_assign_auto', 'bonus_assign_manual', 'bonus_my_rows',
  // رصيد المذاخر وتحريكها
  'stock_ledger_baseline', 'stock_ledger_movement_upload', 'stock_ledger_manual', 'stock_ledger_alerts', 'stock_ledger_export', 'stock_ledger_delete',
  'stock_flow_counts', 'stock_flow_team_upload', 'stock_flow_delete', 'stock_flow_export',
  // نشاط الفريق
  'team_engagement_member_detail', 'team_engagement_time', 'team_engagement_days', 'team_engagement_top_pages',
  'team_engagement_list_last_seen', 'team_engagement_list_opens', 'team_engagement_list_minutes', 'team_engagement_list_heatmap',
  // فرق المحافظات ومتابعة المندوبين
  'province_teams_personal', 'province_teams_structure', 'rep_followup_standards', 'rep_followup_digest', 'rep_followup_recompute',
  // ستوك المذاخر
  'sales_data_upload', 'sales_data_delete', 'sales_data_merge', 'sales_data_export', 'sales_data_shortage', 'sales_data_classify', 'sales_data_value', 'sales_data_analysis',
  // عامة
  'ai_assistant', 'switch_account',
];

/** صلاحيات حساب جديد قبل أي تخصيص. */
export function newUserPermissions() {
  return {
    disabledFeatures: [...NEW_USER_DISABLED_FEATURES],
    enabledFeatures: [...NEW_USER_ENABLED_OPT_IN],
    requireGps: true,
  };
}
