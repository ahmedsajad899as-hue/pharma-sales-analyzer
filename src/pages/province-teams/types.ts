// أنواع صفحة «فرق المحافظات» — تطابق ما يُرجعه server/modules/province-teams.

export type ViewerMode = 'office' | 'leader' | 'company' | 'rep';

export interface Viewer {
  id: number; name: string; role: string; mode: ViewerMode;
  canEditStructure: boolean; hasOffice: boolean;
}

export interface NetRow { name: string; net: number; qty: number; itemId?: number; channel?: 'warehouse' | 'pharmacy' }

/** كل القيم بالدولار (مُطبَّعة في الخادم) — تُعرض بعملة الملفات عبر Money. */
export interface CoverageStats {
  salesValue: number; returnValue: number; net: number; netQty: number;
  warehouseNet: number; pharmacyNet: number; orders: number; customers: number;
  byItem: NetRow[]; byArea: NetRow[]; topCustomers: NetRow[];
}

export interface PersonalTotals { valueUSD: number; qty: number; rows: number; pharmacies: number }

export interface RepCompany {
  assignmentId: number; companyId: number; companyName: string;
  allItems: boolean; itemCount: number; explicitItemIds: number[];
  coverage: CoverageStats; personal: PersonalTotals;
}

export interface RepRow {
  repUserId: number; repName: string; repActive: boolean;
  companies: RepCompany[]; totalNet: number; totalQty: number; personalUSD: number;
  personalUnclassified: PersonalTotals | null;
}

export interface Uncovered { companyId: number; companyName: string; net: number; netQty: number; topItems: NetRow[] }

export interface Team {
  id: number; provinceId: number; provinceName: string;
  leaderUserId: number | null; leaderName: string | null; notes: string | null;
  canReview: boolean; isLeader: boolean; fullView: boolean;
  companies: { id: number; name: string }[];
  totals: CoverageStats; personalUSD: number;
  reps: RepRow[]; uncovered: Uncovered[];
  overlaps: { itemId: number; keptAssignmentId: number; droppedAssignmentId: number }[];
  pendingPersonal: number;
}

export interface Overview {
  viewer: Viewer;
  month: string;
  files: { count: number; source: string; names: string[]; excludedMercato: number; currency: 'IQD' | 'USD'; rate: number };
  teams: Team[];
  provinces?: { id: number; name: string }[];
}

export interface PersonalSale {
  id: number; teamId: number | null; provinceName: string | null;
  repUserId: number | null; repName: string | null;
  companyId: number | null; companyName: string | null;
  itemId: number | null; itemName: string; pharmacyName: string; areaName: string | null;
  channel: 'warehouse' | 'office'; warehouseName: string | null;
  quantity: number; bonusQty: number; unitPrice: number | null; totalValue: number; currency: 'IQD' | 'USD';
  saleDate: string; invoiceNo: string | null; notes: string | null;
  status: 'pending' | 'approved' | 'rejected'; rejectReason: string | null;
  reviewedBy: string | null; reviewedAt: string | null;
  entrySource: 'app' | 'telegram' | 'viber' | 'whatsapp'; senderName: string | null;
  createdAt: string; canReview: boolean; canEdit: boolean;
}

export interface Option { id: number; name: string; role?: string; company?: string | null; itemCount?: number }
export interface Options { provinces: Option[]; leaders: Option[]; reps: Option[]; companies: Option[] }
export interface CatalogItem { id: number; name: string; scientificName?: string | null; price: number | null; warehousePrice: number | null; companyId?: number; companyName?: string; teamId?: number }
