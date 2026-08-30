import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, FolderOpen, Hospital, CalendarRange, CalendarCheck,
  ClipboardList, TestTube, BarChart3, Package, Filter, FlaskConical,
  Search, Calculator, Gift, FileBarChart2, Users, Wallet, Building2, Send,
  Bot, X, PhoneCall, TrendingUp, RotateCcw, Shuffle, Check, CheckCircle2,
  PauseCircle, Circle, Trash2, Plus, Download, Upload, ArrowLeftRight,
  Link2, Settings, Loader2, AlertTriangle, ChevronRight, ChevronLeft,
  Store, Pill, Bell, Pencil, LogOut, Globe, User, MapPin, Stethoscope,
  Phone, RefreshCw, History, Banknote, Tag, Hash, FileText, Calendar,
  Scale, FileSpreadsheet, Target, Eye, Mic, Folder, Home, Crown, Shield,
  Rocket, Monitor, Ban, Repeat, Mail, ThumbsUp, ThumbsDown, DoorOpen,
  Plane, HelpCircle, Menu,
} from 'lucide-react';

/**
 * خريطة موحّدة لكل الأيقونات المستخدمة في القائمة الجانبية وشاشات الشيل العام
 * (8 صفحات رئيسية + Sidebar + AIAssistant). مفتاح واحد لكل مفهوم بدل تكرار
 * استيراد lucide-react داخل كل صفحة على حدة.
 */
export const ICONS = {
  // نفس ترتيب/معرّفات NAV_ITEMS في featureConfig.ts
  navDashboard: LayoutDashboard,
  navRepAnalysis: FolderOpen,
  navDoctors: Hospital,
  navMonthlyPlans: CalendarRange,
  navDailyPlan: CalendarCheck,
  navMasterSurvey: ClipboardList,
  navFms: TestTube,
  navSalesData: BarChart3,
  navDistributorSales: Package,
  navFileFilter: Filter,
  navPharmacyAnalysis: FlaskConical,
  navItemAnalysis: Search,
  navAccountBuilder: Calculator,
  navBonusSales: Gift,
  navReports: FileBarChart2,
  navUsers: Users,
  navCommercial: Wallet,
  navOrgStructure: Building2,
  navAqdarExport: Send,

  // شيل عام
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  aiBot: Bot,

  // أزرار عائمة
  fabCall: PhoneCall,

  // أنواع الرفع
  uploadSales: TrendingUp,
  uploadReturns: RotateCcw,
  uploadAuto: Shuffle,

  // مفاهيم متكررة
  close: X,
  check: Check,
  checkCircle: CheckCircle2,
  pause: PauseCircle,
  empty: Circle,
  delete: Trash2,
  add: Plus,
  export: Download,
  import: Upload,
  transfer: ArrowLeftRight,
  link: Link2,
  settings: Settings,
  search: Search,
  filter: Filter,
  loading: Loader2,
  warning: AlertTriangle,
  pharmacy: Store,
  drug: Pill,
  alert: Bell,
  edit: Pencil,
  logout: LogOut,
  language: Globe,
  person: User,
  location: MapPin,
  doctor: Stethoscope,
  call: Phone,
  refresh: RefreshCw,
  history: History,
  money: Banknote,
  category: Tag,
  count: Hash,
  file: FileText,
  calendar: Calendar,
  netBalance: Scale,
  excel: FileSpreadsheet,
  target: Target,
  view: Eye,
  mic: Mic,
  folder: Folder,
  home: Home,
  crown: Crown,
  shield: Shield,
  rocket: Rocket,
  monitor: Monitor,
  blocked: Ban,
  repeat: Repeat,
  mail: Mail,
  thumbsUp: ThumbsUp,
  thumbsDown: ThumbsDown,
  exit: DoorOpen,
  travel: Plane,
  help: HelpCircle,
  menu: Menu,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** يربط معرّف عنصر القائمة الجانبية (NAV_ITEMS[].id) بأيقونة Lucide — بدون لمس featureConfig.ts,
 *  لأن NAV_ITEMS[].icon (إيموجي) يُستهلك أيضاً كنص خام في شاشة صلاحيات السوبر أدمن. */
export const NAV_ICON_BY_ID: Record<string, IconName> = {
  'dashboard': 'navDashboard',
  'rep-analysis': 'navRepAnalysis',
  'doctors': 'navDoctors',
  'monthly-plans': 'navMonthlyPlans',
  'daily-plan': 'navDailyPlan',
  'master-survey': 'navMasterSurvey',
  'fms': 'navFms',
  'sales-data': 'navSalesData',
  'distributor-sales': 'navDistributorSales',
  'file-filter': 'navFileFilter',
  'pharmacy-analysis': 'navPharmacyAnalysis',
  'item-analysis': 'navItemAnalysis',
  'account-builder': 'navAccountBuilder',
  'bonus-sales': 'navBonusSales',
  'reports': 'navReports',
  'users': 'navUsers',
  'commercial': 'navCommercial',
  'org-structure': 'navOrgStructure',
  'aqdar-export': 'navAqdarExport',
};

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

/** غلاف رفيع فوق مكوّنات lucide-react — اللون يتبع currentColor افتراضياً
 *  حتى يتوارث لون النص/الزر المحيط تلقائياً بدل تلوين كل استخدام يدوياً. */
export function Icon({ name, size = 18, strokeWidth = 2, className, style }: IconProps) {
  const Cmp = ICONS[name];
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} style={{ flexShrink: 0, ...style }} />;
}
