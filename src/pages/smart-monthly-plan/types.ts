// أنواع مشتركة للبلان الشهري الذكي — مطابقة لشكل استجابات
// server/modules/smart-monthly-plans بالضبط.

export interface SmartRep {
  id: number;
  name: string;
}

export type UploadKind = 'prescribers' | 'candidates' | 'survey' | 'openPharmacies';

export interface RatioBucket {
  key: string;
  label: string;
  percent: number;
  sourceTag: string;
}

export interface BucketSummary extends RatioBucket {
  quota: number;
  poolSize: number;
  shortfall: number;
  filledCount?: number;
}

export interface SmartPlan {
  id: number;
  userId: number;
  scientificRepId: number;
  month: number;
  year: number;
  title: string | null;
  status: 'draft' | 'resolving' | 'ready' | 'exported';
  targetDoctorCount: number;
  ratioConfig: RatioBucket[];
  resultSummary: BucketSummary[] | null;
  lastRunAt: string | null;
  exportedAt: string | null;
  createdAt: string;
  scientificRep?: SmartRep;
}

export interface AreaDoctor {
  id: number;
  key: string;
  name: string;
  specialty: string | null;
  className: string | null;
  phone: string | null;
  included: boolean;
}

export interface AreaPharmacy {
  name: string | null; // null = أطباء بلا صيدلية مسجَّلة
  openPharmacy: boolean;
  matchedOpenPharmacy: string | null;
  doctors: AreaDoctor[];
}

export interface AreaWithDoctors {
  areaId: number;
  areaName: string;
  pharmacies: AreaPharmacy[];
}

export interface SmartPlanUpload {
  id: number;
  smartPlanId: number;
  kind: UploadKind;
  fileName: string;
  rowCount: number;
  matchedCount: number;
  createdAt: string;
}

export interface SmartPlanCandidate {
  id: number;
  smartPlanId: number;
  doctorId: number | null;
  rawName: string;
  pharmacyName: string | null;
  areaName: string | null;
  items: string[] | null;
  sourceFlags: Record<string, boolean>;
  assignedBucketKey: string | null;
  matchConfidence: number | null;
  matchTier: 'linked' | 'exact' | 'ask' | 'ai_resolved' | 'new' | null;
  selected: boolean;
  aiScore: number | null;
  aiReason: string | null;
  doctor?: { id: number; name: string; area?: { name: string } | null } | null;
}

export interface AmbiguousSuggestion {
  id: number;
  name: string;
  score: number;
  areaName?: string | null;
  specialty?: string | null;
  pharmacyName?: string | null;
  crossArea?: boolean;
}

export interface AmbiguousGroup {
  raw: string;
  key: string;
  candidateId: number;
  areaName?: string | null;
  specialty?: string | null;
  pharmacyName?: string | null;
  suggestions: AmbiguousSuggestion[];
}

export const DEFAULT_RATIO_CONFIG: RatioBucket[] = [
  { key: 'prescriberLinked',   label: 'يكتبون الايتم',   percent: 50, sourceTag: 'prescriberLinked' },
  { key: 'openPharmacyLinked', label: 'صيدليات مفتوحة',  percent: 20, sourceTag: 'openPharmacyLinked' },
  { key: 'inSurvey',           label: 'من السيرفي',      percent: 20, sourceTag: 'inSurvey' },
  { key: 'inCandidateList',    label: 'مرشّحون',         percent: 10, sourceTag: 'inCandidateList' },
];

export const UPLOAD_KIND_META: Record<UploadKind, { label: string; hint: string; icon: string }> = {
  prescribers: {
    label: 'الأطباء الذين يكتبون الايتم',
    hint: 'اسم الطبيب + الصيدلية + المنطقة + الايتم (أو أكثر من ايتم)',
    icon: '✍️',
  },
  candidates: {
    label: 'أطباء مرشّحون للبلان',
    hint: 'اسم الطبيب (والمنطقة/الصيدلية إن توفّرت)',
    icon: '🗒️',
  },
  survey: {
    label: 'سيرفي مناطق المندوب',
    hint: 'اختياري — عند عدم الرفع تُستخدم بيانات السيرفي المسجَّلة تلقائياً لمناطق هذا المندوب',
    icon: '🧭',
  },
  openPharmacies: {
    label: 'صيدليات مفتوحة (تُجهَّز من المكتب)',
    hint: 'قائمة أسماء صيدليات — يُربَط أي طبيب اسم صيدليته مطابق لأحدها',
    icon: '🏬',
  },
};
