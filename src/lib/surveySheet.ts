// ════════════════════════════════════════════════════════════════════════════
// surveySheet.ts — بناء وقراءة ملف مراجعة السيرفي
// ────────────────────────────────────────────────────────────────────────────
// الملف الذي يستلمه المندوب ويُعيده. عمود «الرمز» هو ما يحوّل إعادة الرفع من
// تخمين بالأسماء إلى مطابقة قاطعة، وورقة _meta المخفية تحمل رمز التصدير الذي
// يربط الملف بلقطة بصماته في السيرفر (أساس كشف التعارض).
//
// خرائط الأعمدة هنا هي المصدر الوحيد: كانت نسخة منها داخل MasterSurveyPage
// ونسخ أخرى في الباكند، وهذا الملف يخدم التصدير والاستيراد القديم والجديد معاً.
// ════════════════════════════════════════════════════════════════════════════

import * as XLSX from 'xlsx';

export type SyncEntryType = 'doctor' | 'pharmacy';

export type DocField = 'name' | 'specialty' | 'areaName' | 'pharmacyName' | 'className' | 'zoneName' | 'phone' | 'notes';
export type PharmaField = 'name' | 'ownerName' | 'pharmacyName' | 'phone' | 'address' | 'areaName' | 'notes';
export type AnyField = DocField | PharmaField;

export const CODE_HEADER = 'الرمز';
export const ACTION_HEADER = 'الإجراء';
const META_SHEET = '_meta';
const HELP_SHEET = 'تعليمات';

// ── خرائط الأعمدة ───────────────────────────────────────────────────────────
// ⚠️ الترتيب مقصود: أول تطابق يفوز. وانتبه للانعكاس المتعمَّد في ملف الأطباء —
// عمود «zone» الإنجليزي يقابل areaName بينما «area/region» يقابل zoneName،
// لأن الملفات الواردة من الأنظمة الأخرى تستعمل المصطلحين بالمعنى المعكوس.
export const DOC_FIELD_KEYWORDS: Array<[DocField, string[]]> = [
  ['name',         ['اسم الطبيب','الطبيب','الدكتور','الاسم الكامل','الاسم','اسم الدكتور','doctor','name','physician']],
  ['specialty',    ['الاختصاص','التخصص','تخصص','اختصاص','specialty','speciality','speciality_1','spec']],
  ['areaName',     ['المنطقه','منطقه','اسم المنطقه','الحي','حي','zone','sector','zone name','zone_name']],
  ['pharmacyName', ['اسم الصيدليه','اسم الصيدلية','الصيدليه','الصيدلية','صيدليه','صيدلية','اسم الدكان','الدكان','دكان','pharmacy name','pharmacy_name','pharmacyname','pharmacy','pharmcy','pharmc','clinic']],
  ['className',    ['الكلاس','كلاس','التصنيف','تصنيف','الفئه','فئه','class','classification','cat','category']],
  ['zoneName',     ['الزون','زون','القطاع','قطاع','منطقه فرعيه','area','region','area name']],
  ['phone',        ['الهاتف','رقم الهاتف','الجوال','رقم الجوال','موبايل','جوال','هاتف','تلفون','phone','mobile','tel','phone number','mobile number']],
  ['notes',        ['ملاحظات','ملاحظه','تعليق','تعليقات','notes','note','remarks']],
];

export const PHARMA_FIELD_KEYWORDS: Array<[PharmaField, string[]]> = [
  ['ownerName',    ['صاحب الصيدلية','صاحب الدكان','المالك','صاحب','المدير','مدير','owner','ownername','owner name']],
  ['pharmacyName', ['الفرع','فرع','الماركة','ماركة','السلسلة','سلسلة','chain','brand','branch']],
  ['phone',        ['الهاتف','رقم الهاتف','الجوال','رقم الجوال','موبايل','جوال','هاتف','تلفون','phone','mobile','tel','phone number','mobile number']],
  ['address',      ['العنوان','عنوان','الموقع','address','location','street']],
  ['areaName',     ['المنطقة','المنطقه','منطقة','اسم المنطقة','area','region','area name']],
  ['notes',        ['ملاحظات','ملاحظه','تعليق','تعليقات','notes','note','remarks']],
  // الأعم أخيراً: «الصيدلية» تطابق أي عمود يذكرها، فلا تُجرَّب إلا بعد فشل الباقي.
  ['name',         ['اسم الصيدلية','اسم الدكان','الصيدلية','صيدلية','الدكان','دكان','الاسم الكامل','الاسم','اسم','pharmacy name','pharmacy_name','pharmacyname','pharmacy','name']],
];

export const SHEET_DEF: Record<SyncEntryType, {
  sheetName: string;
  fileLabel: string;
  fields: AnyField[];
  headers: Record<string, string>;
  keywords: Array<[any, string[]]>;
}> = {
  doctor: {
    sheetName: 'الأطباء',
    fileLabel: 'أطباء',
    fields: ['name', 'specialty', 'areaName', 'pharmacyName', 'className', 'zoneName', 'phone', 'notes'],
    headers: {
      name: 'اسم الطبيب', specialty: 'الاختصاص', areaName: 'المنطقة',
      pharmacyName: 'اسم الصيدلية', className: 'الكلاس', zoneName: 'الزون',
      phone: 'الهاتف', notes: 'ملاحظات',
    },
    keywords: DOC_FIELD_KEYWORDS,
  },
  pharmacy: {
    sheetName: 'الصيدليات',
    fileLabel: 'صيدليات',
    fields: ['name', 'ownerName', 'pharmacyName', 'phone', 'address', 'areaName', 'notes'],
    headers: {
      name: 'اسم الصيدلية', ownerName: 'صاحب الصيدلية', pharmacyName: 'الفرع / السلسلة',
      phone: 'الهاتف', address: 'العنوان', areaName: 'المنطقة', notes: 'ملاحظات',
    },
    keywords: PHARMA_FIELD_KEYWORDS,
  },
};

// ── كشف الأعمدة ─────────────────────────────────────────────────────────────
export function normalizeHdr(h: string): string {
  return String(h ?? '').trim().toLowerCase()
    .replace(/[_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ة/g, 'ه')
    .replace(/[ً-ٟ]/g, '');
}

function isReservedHeader(h: string): boolean {
  const n = normalizeHdr(h);
  return n === normalizeHdr(CODE_HEADER) || n === normalizeHdr(ACTION_HEADER);
}

export function detectField(entryType: SyncEntryType, header: string): AnyField | null {
  if (isReservedHeader(header)) return null;
  const h = normalizeHdr(header);
  if (!h) return null;
  for (const [field, kws] of SHEET_DEF[entryType].keywords) {
    for (const kw of kws) {
      const nkw = normalizeHdr(kw);
      if (h === nkw || h.includes(nkw) || nkw.includes(h)) return field as AnyField;
    }
  }
  return null;
}

export function detectDocField(header: string) { return detectField('doctor', header) as DocField | null; }
export function detectPharmaField(header: string) { return detectField('pharmacy', header) as PharmaField | null; }

/** خريطة عنوان→حقل، بحيث لا يُربط حقل واحد بعمودين (أول عمود يفوز). */
export function buildHeaderMap(entryType: SyncEntryType, headers: string[]): Record<string, AnyField> {
  const map: Record<string, AnyField> = {};
  const used = new Set<AnyField>();
  for (const h of headers) {
    const f = detectField(entryType, h);
    if (f && !used.has(f)) { map[h] = f; used.add(f); }
  }
  return map;
}

// ── التصدير ─────────────────────────────────────────────────────────────────
export interface SurveySheetRow {
  code: string;
  action?: string;
  [field: string]: any;
}

export interface BuildOptions {
  entryType: SyncEntryType;
  rows: SurveySheetRow[];
  token: string;
  surveyName?: string;
  scopeLabel?: string;   // «مناطق المندوب فلان» أو ما شابه — يظهر في التعليمات
  fileName?: string;
}

/** يبني المصنَّف ويُنزّله في المتصفح. */
export function downloadSurveySheet(opts: BuildOptions): string {
  const { entryType, rows, token, surveyName = '', scopeLabel = '' } = opts;
  const def = SHEET_DEF[entryType];

  const headerRow = [CODE_HEADER, ...def.fields.map(f => def.headers[f]), ACTION_HEADER];
  const aoa: any[][] = [headerRow, ...rows.map(r => [
    r.code ?? '',
    ...def.fields.map(f => r[f] ?? ''),
    r.action ?? '',
  ])];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, ...def.fields.map(f => ({ wch: Math.max(14, Math.min(34, def.headers[f].length + 12)) })), { wch: 12 }];
  (ws as any)['!views'] = [{ RTL: true }];
  // تجميد صف العناوين وعمود الرمز: الملف قد يحوي آلاف الصفوف، وبدون التجميد
  // يفقد المندوب الرمز والعنوان فور التمرير فيعدّل الصف الخطأ.
  (ws as any)['!freeze'] = { xSplit: 1, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, def.sheetName);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildHelpSheet(entryType, surveyName, scopeLabel, rows.length)), HELP_SHEET);

  // ورقة الربط: رمز التصدير يربط هذا الملف بلقطة بصماته في السيرفر. مخفية كي
  // لا يعبث بها أحد سهواً — وفقدانها ليس كارثة: الرفع يعمل بلا رمز لكن بلا
  // كشف تعارض.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['token', token],
    ['entryType', entryType],
    ['exportedAt', new Date().toISOString()],
    ['rowCount', String(rows.length)],
  ]), META_SHEET);
  (wb as any).Workbook = {
    Sheets: wb.SheetNames.map(n => ({ name: n, Hidden: n === META_SHEET ? 1 : 0 })),
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const name = opts.fileName ?? `سيرفي-${def.fileLabel}-${stamp}.xlsx`;
  XLSX.writeFile(wb, name);
  return name;
}

function buildHelpSheet(entryType: SyncEntryType, surveyName: string, scopeLabel: string, rowCount: number): any[][] {
  const def = SHEET_DEF[entryType];
  const what = entryType === 'doctor' ? 'الطبيب' : 'الصيدلية';
  return [
    ['تعليمات تحديث السيرفي'],
    [],
    ['السيرفي', surveyName || '—'],
    ['النطاق', scopeLabel || 'كل الصفوف'],
    ['عدد الصفوف', rowCount],
    ['تاريخ التصدير', new Date().toLocaleDateString('ar-IQ')],
    [],
    ['كيف تعدّل'],
    ['١', `لتعديل بيانات ${what}: غيّر الخلية مباشرة واترك عمود «${CODE_HEADER}» كما هو.`],
    ['٢', `لنقل ${what} لمنطقة أخرى: غيّر خلية «المنطقة» فقط.`],
    ['٣', `لإضافة ${what} جديد: أضف صفاً في آخر الورقة واترك «${CODE_HEADER}» فارغاً.`],
    ['٤', `لطلب حذف ${what}: اكتب كلمة «حذف» في عمود «${ACTION_HEADER}» ولا تحذف الصف.`],
    ['٥', 'لمسح محتوى خانة عمداً: اكتب فيها شرطة واحدة ( - ).'],
    [],
    ['تنبيهات مهمة'],
    ['•', `لا تغيّر عمود «${CODE_HEADER}» ولا تحذفه — هو ما يعرف به النظام أن هذا الصف هو نفسه ${what} الموجود.`],
    ['•', 'حذف صف من الملف لا يحذفه من النظام — يُعتبر «لم تراجعه». الحذف يُطلب بالكلمة فقط.'],
    ['•', 'خانة فارغة تعني «لم أغيّرها»، ولا تمسح ما هو مسجَّل. للمسح استعمل الشرطة.'],
    ['•', 'لا تحذف ورقة _meta المخفية — بها رمز يربط ملفك بنسخته الأصلية لكشف أي تعارض.'],
    ['•', 'كل تعديلاتك تمر على مراجعة الإدارة قبل أن تُطبَّق. لا شيء يضيع ولا شيء يُطبَّق تلقائياً.'],
    [],
    ['الأعمدة'],
    [CODE_HEADER, 'رمز ثابت — لا يُعدَّل'],
    ...def.fields.map(f => [def.headers[f], f === 'name' ? 'مطلوب' : 'اختياري']),
    [ACTION_HEADER, 'اتركه فارغاً، أو اكتب «حذف»'],
  ];
}

// ── القراءة ─────────────────────────────────────────────────────────────────
export interface ParsedSurveySheet {
  token: string | null;
  entryType: SyncEntryType | null;   // من ورقة _meta إن وُجدت
  rows: Record<string, any>[];       // كل صف: __row + code + الحقول + action
  detectedMapping: Record<string, string>;
  unknownColumns: string[];
  hasCodeColumn: boolean;
  sheetName: string;
}

function readMeta(wb: XLSX.WorkBook): { token: string | null; entryType: SyncEntryType | null } {
  const ws = wb.Sheets[META_SHEET];
  if (!ws) return { token: null, entryType: null };
  const aoa = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, blankrows: false });
  const map = new Map<string, string>();
  for (const r of aoa) if (r?.[0] != null) map.set(String(r[0]).trim(), String(r[1] ?? '').trim());
  const t = map.get('entryType');
  return {
    token: map.get('token') || null,
    entryType: (t === 'doctor' || t === 'pharmacy') ? t : null,
  };
}

/**
 * يقرأ ملف المراجعة. يختار ورقة البيانات بالاسم المتوقَّع، وإلا أول ورقة ليست
 * _meta ولا «تعليمات» — كي يعمل أيضاً مع ملف أعاد المندوب حفظه أو أعاد ترتيب
 * أوراقه.
 */
export function parseSurveySheet(data: ArrayBuffer, entryType: SyncEntryType): ParsedSurveySheet {
  const wb = XLSX.read(new Uint8Array(data), { type: 'array' });
  const meta = readMeta(wb);
  const def = SHEET_DEF[entryType];

  const dataSheetName =
    wb.SheetNames.find(n => n === def.sheetName) ??
    wb.SheetNames.find(n => n !== META_SHEET && n !== HELP_SHEET) ??
    wb.SheetNames[0];

  const ws = wb.Sheets[dataSheetName];
  const aoa = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, blankrows: false, defval: '' });
  if (aoa.length === 0) {
    return { token: meta.token, entryType: meta.entryType, rows: [], detectedMapping: {}, unknownColumns: [], hasCodeColumn: false, sheetName: dataSheetName };
  }

  const headers = (aoa[0] ?? []).map(h => String(h ?? '').trim());
  const headerMap = buildHeaderMap(entryType, headers);

  let codeIdx = -1, actionIdx = -1;
  headers.forEach((h, i) => {
    const n = normalizeHdr(h);
    if (n === normalizeHdr(CODE_HEADER)) codeIdx = i;
    else if (n === normalizeHdr(ACTION_HEADER)) actionIdx = i;
  });

  const fieldIdx: Array<[number, AnyField]> = [];
  headers.forEach((h, i) => { if (headerMap[h]) fieldIdx.push([i, headerMap[h]]); });

  const rows: Record<string, any>[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const raw = aoa[i] ?? [];
    const row: Record<string, any> = {
      // رقم الصف كما يراه المندوب في إكسل (العناوين في الصف ١) — هو ما يُعرض
      // في شاشة المراجعة كي يستطيع الرجوع للخلية نفسها في ملفه.
      __row: i + 1,
      code: codeIdx >= 0 ? String(raw[codeIdx] ?? '').trim() : '',
      action: actionIdx >= 0 ? String(raw[actionIdx] ?? '').trim() : '',
    };
    let any = false;
    for (const [idx, f] of fieldIdx) {
      const v = raw[idx];
      const s = v == null ? '' : String(v).trim();
      row[f] = s;
      if (s) any = true;
    }
    if (!any && !row.code && !row.action) continue; // صف فارغ تماماً
    rows.push(row);
  }

  const detectedMapping: Record<string, string> = {};
  for (const [h, f] of Object.entries(headerMap)) detectedMapping[h] = def.headers[f] ?? f;

  return {
    token: meta.token,
    entryType: meta.entryType,
    rows,
    detectedMapping,
    unknownColumns: headers.filter(h => h && !headerMap[h] && !isReservedHeader(h)),
    hasCodeColumn: codeIdx >= 0,
    sheetName: dataSheetName,
  };
}

/** غلاف يقرأ File من input مباشرة. */
export function readSurveySheetFile(file: File, entryType: SyncEntryType): Promise<ParsedSurveySheet> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try { resolve(parseSurveySheet(e.target?.result as ArrayBuffer, entryType)); }
      catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ── عرض الرمز في الواجهة ────────────────────────────────────────────────────
export function formatSurveyCode(entryType: SyncEntryType, id: number): string {
  if (!Number.isInteger(id) || id <= 0) return '';
  return `${entryType === 'doctor' ? 'D' : 'P'}-${String(id).padStart(6, '0')}`;
}

export const CHANGE_LABELS: Record<string, string> = {
  unchanged: 'بلا تغيير',
  update: 'تعديل',
  move: 'نقل منطقة',
  new: 'جديد',
  delete: 'طلب حذف',
  conflict: 'تعارض',
  unmatched: 'بلا مطابقة',
};

export const CHANGE_COLORS: Record<string, string> = {
  unchanged: '#94a3b8',
  update: '#2563eb',
  move: '#7c3aed',
  new: '#059669',
  delete: '#dc2626',
  conflict: '#ea580c',
  unmatched: '#ca8a04',
};
