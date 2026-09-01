import type { PageId } from '../App';
import type { IconName } from './icons';
import { NAV_ICON_BY_ID } from './icons';

export interface PageHeader {
  title: string;
  subtitle?: string;
}

/**
 * عنوان/وصف كل صفحة يظهر في الشريط العلوي الثابت (App-level topbar).
 * مصدر واحد مركزي — عدّل هنا فقط لتغيير ما يظهر لأي صفحة، بلا حاجة للمس الصفحة نفسها.
 * يعتمد أولاً على النص الفعلي الظاهر حالياً داخل كل صفحة (وليس بالضرورة تسمية القائمة
 * الجانبية، لأنهما يختلفان أحياناً — مثال: 'doctors' اسمه بالقائمة "تحليل الكولات"
 * لكن عنوانه الداخلي الفعلي "قائمة السيرفي").
 */
export const PAGE_HEADERS: Partial<Record<PageId, PageHeader>> = {
  'dashboard':          { title: 'الرئيسية', subtitle: 'نظرة عامة على أداء المندوبين اليوم' },
  'rep-analysis':       { title: 'تحليل ملفات المندوبين', subtitle: 'رفع وإدارة ملفات المبيعات' },
  'upload':             { title: 'رفع الملفات', subtitle: 'رفع وإدارة ملفات المبيعات' },
  'doctors':            { title: 'قائمة السيرفي' },
  'monthly-plans':      { title: 'البلانات الشهرية' },
  'daily-plan':         { title: 'البلان اليومي', subtitle: 'زيارات اليوم ونسبة التحقيق' },
  'master-survey':      { title: 'السيرفيات', subtitle: 'قوائم الأطباء والصيدليات المشتركة من الإدارة' },
  'fms':                { title: 'FMS — عينات شهرية' },
  'sales-data':         { title: 'بيانات المبيعات', subtitle: 'تحليل ملفات Excel مع البحث المتعدد' },
  'stock-ledger':       { title: 'رصيد المذاخر', subtitle: 'المتبقّي فعلاً في كل مذخر ومتى يحتاج طلبية جديدة' },
  'distributor-sales':  { title: 'تحليل مبيعات الموزعين', subtitle: 'رفع وتحليل ملفات Excel بتنسيق امازون / فريق' },
  'file-filter':        { title: 'تنقية الملفات' },
  'pharmacy-analysis':  { title: 'تحليل الصيدليات والمبيعات' },
  'item-analysis':      { title: 'تحليل الإيتم' },
  'account-builder':    { title: 'الحساب', subtitle: 'إنشاء حسابات ومعادلات خاصة بالإيتمات' },
  'bonus-sales':        { title: 'مبيعات البونص والتعويضات', subtitle: 'رفع ومقارنة ملفات المبيعات والتعويضات — متابعة تسليم البونص' },
  'reports':            { title: 'التقارير' },
  'users':              { title: 'المستخدمين' },
  'commercial':         { title: 'القسم التجاري' },
  'org-structure':      { title: 'الهيكلية' },
  'aqdar-export':       { title: 'أقدر' },
  'representatives':    { title: 'المندوبين' },
  'scientific-reps':    { title: 'المندوبون العلميون' },
};

const FALLBACK_ICON: IconName = 'navDashboard';

export function getPageHeader(pageId: PageId, fallbackTitle: string): PageHeader {
  return PAGE_HEADERS[pageId] ?? { title: fallbackTitle };
}

export function getPageHeaderIcon(pageId: PageId): IconName {
  return (NAV_ICON_BY_ID[pageId] as IconName) ?? FALLBACK_ICON;
}
