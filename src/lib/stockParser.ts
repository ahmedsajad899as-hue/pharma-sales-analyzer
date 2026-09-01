/**
 * stockParser.ts — قراءة ملفات الستوك (Excel) وتحويلها إلى صيغة SalesFile.
 *
 * فُصل هذا المنطق عن SalesDataPage.tsx ليكون قابلاً للاختبار بمعزل عن React
 * (راجع scripts/test-stock-parser.mjs).
 *
 * الصيغ المدعومة (تُجرَّب بهذا الترتيب في parseStockFile):
 *   1. parseDistributorSales — عدة شيتات = محافظات، وأعمدة كمية/صافي مبيع.
 *   2. parseMultiSheetStock  — شيت لكل شركة، صف 0 عنوان، صف 1 رؤوس، المادة في العمود A.
 *   3. parseStockMatrix      — صيغة المصفوفة (الأكثر شيوعاً) وهي الاحتياطي النهائي.
 *
 * صيغة المصفوفة:
 *   صف المناطق   : خلايا مدموجة (أو ملوّنة)، كل خلية = منطقة تغطي أعمدة مذاخرها.
 *   صف الرؤوس    : item code | Item | price | ...أسماء المذاخر
 *   صفوف البيانات : كود الشركة | اسم الايتم | السعر | كمية لكل مذخر
 *
 * حسب توصيف المستخدم: «item code» هو نفسه اسم الشركة، و«Item» هو اسم الايتم،
 * و«price» هو السعر — لذلك تُطبَّع أعمدة التعريف دائماً إلى: الشركة | المادة | السعر.
 */
import * as XLSX from 'xlsx';

// ── Types ──────────────────────────────────────────────────────────────────────
export interface ColMeta {
  key: string;
  label: string;
  region: string;
  colIdx: number;
}

export interface SalesFile {
  id: string;
  name: string;
  uploadedAt: string;
  fixedCols: string[];
  areaCols: ColMeta[];
  rows: Record<string, string>[];
  regions: string[];
  sourceFileIds?: string[]; // set on merged files only
  _mergeDebug?: { file: string; companyCol: string; itemCol: string; rows: number }[];
}

export type RegionTotalCol = { key: string; label: string; region: string; colIdx: -1; isRegionTotal: true; cols: ColMeta[] };
export type ViewCol = ColMeta | RegionTotalCol;
export function isRT(col: ViewCol): col is RegionTotalCol { return 'isRegionTotal' in col; }

// ── Helpers ────────────────────────────────────────────────────────────────────
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const toNum = (v: string) => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
export const normalizeItemName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** رقم محاسبي: "(9.00)" → -9 */
export function toNumAcc(v: unknown): number {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (/^\([\d.]+\)$/.test(s)) return -parseFloat(s.slice(1, -1));
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

export function cellVal(row: Record<string, string>, col: ViewCol): number {
  if (isRT(col)) return col.cols.reduce((s, ac) => s + toNum(row[ac.key] ?? ''), 0);
  return toNum(row[col.key] ?? '');
}
export function rowTotal(row: Record<string, string>, cols: ViewCol[]): number {
  return cols.reduce((s, col) => s + cellVal(row, col), 0);
}

// ── تطبيع رؤوس الأعمدة ────────────────────────────────────────────────────────
/** تطبيع عنوان عمود بنفس طريقة تطبيع القيم (تشكيل، ألف، ة، ى، مسافات) */
export function normColHeader(s: string): string {
  return String(s ?? '').toLowerCase().trim()
    .replace(/[ً-ٰٟ]/g, '')            // حذف التشكيل
    .replace(/[آأإٱ]/g, 'ا') // أ إ آ ٱ → ا
    .replace(/ة/g, 'ه')                     // ة → ه
    .replace(/ى/g, 'ي')                     // ى → ي
    .replace(/[_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const COMPANY_KW = ['company', 'comp', 'شركة', 'الشركة', 'شركه', 'الشركه', 'vendor', 'supplier', 'brand', 'manufacture', 'principal', 'item code', 'itemcode'];
export const ITEM_KW_EXACT = ['item', 'الايتم', 'اسم الايتم', 'اسم المادة', 'اسم الماده', 'المادة', 'مادة', 'المواد', 'مواد', 'name', 'product', 'منتج', 'المنتج', 'الاصناف', 'اصناف', 'صنف', 'الدواء', 'دواء'];
export const ITEM_KW_PART = ['item', 'الايتم', 'اسم', 'نام', 'name', 'product', 'مادة', 'دواء', 'صنف'];
export const PRICE_KW = ['price', 'سعر', 'السعر', 'unit price', 'سعر الوحدة', 'سعر الوحده', 'cost', 'تكلفة'];

/**
 * رؤوس أعمدة التعريف (شركة / مادة / سعر / كود / تسلسل).
 * أي عمود رأسه من هذه القائمة لا يجوز أن يُعامَل كمذخر مهما كان صف المناطق فوقه —
 * وهذا ما كان يجعل «Item» و«price» يظهران ضمن قائمة المذاخر.
 */
const IDENT_HEADERS = new Set([
  // اسم الايتم
  'item', 'items', 'item name', 'itemname', 'الايتم', 'ايتم', 'اسم الايتم', 'المادة', 'ماده', 'الماده', 'مادة',
  'المواد', 'مواد', 'اسم المادة', 'اسم الماده', 'الصنف', 'صنف', 'الاصناف', 'اصناف', 'name', 'اسم', 'الاسم',
  'description', 'desc', 'product', 'product name', 'المنتج', 'منتج', 'الدواء', 'material', 'trade name',
  // الشركة / الكود
  'item code', 'itemcode', 'code', 'الكود', 'كود', 'رمز', 'الرمز', 'barcode', 'sku', 'id', 'الشركة', 'الشركه',
  'شركة', 'شركه', 'company', 'company name', 'vendor', 'supplier', 'brand', 'manufacturer', 'manufacture',
  'principal', 'الوكيل', 'المجهز', 'المنشأ', 'المنشا',
  // السعر
  'price', 'السعر', 'سعر', 'unit price', 'سعر الوحدة', 'سعر الوحده', 'cost', 'التكلفة', 'التكلفه', 'تكلفة', 'تكلفه',
  'currency', 'العملة', 'العمله', 'عملة', 'عمله', 'القيمة', 'القيمه', 'value',
  // تسلسل / وحدة
  'ت', '#', 'no', 'رقم', 'seq', 'unit', 'الوحدة', 'الوحده', 'وحدة', 'وحده', 'pack', 'العبوة', 'العبوه',
].map(normColHeader));

/** هل هذا رأس عمود تعريف (وليس اسم مذخر)؟ */
export function isIdentHeader(h: string): boolean {
  const n = normColHeader(h);
  if (!n) return false;
  if (IDENT_HEADERS.has(n)) return true;
  // مركّبات آمنة فقط: أسماء المذاخر لا تبدأ بأيٍّ من هذه ولا تنتهي بـ code/كود
  return /^(item|unit price|كود|الكود|سعر|السعر|price)\b/.test(n) || /(code|كود)$/.test(n);
}

const TOTAL_RE = /مجموع|اجمالي|إجمالي|الاجمالي|الإجمالي|الكلي|grand.?total|total.?iraq|total.?all|sub.?total|subtotal|overall|^total$/i;
export function isTotalHeader(s: string): boolean { return !!s && TOTAL_RE.test(String(s)); }

const EXPIRY_RE = /اكسباير|اكسبير|expir|صلاحي|انتهاء|تاريخ/i;
export function isExpiryHeader(s: string): boolean { return !!s && EXPIRY_RE.test(String(s)); }

// ── كشف أدوار الأعمدة داخل SalesFile مُحلَّل ────────────────────────────────────
export function detectCompanyCol(f: { fixedCols: string[] }): string {
  const normed = f.fixedCols.map(c => normColHeader(c));
  const kwNormed = COMPANY_KW.map(normColHeader);
  return f.fixedCols.find((_, i) => kwNormed.some(k => normed[i].includes(k))) ?? '';
}

export function detectItemNameCol(f: { fixedCols: string[] }): string {
  const normed = f.fixedCols.map(c => normColHeader(c));
  const exactN = ITEM_KW_EXACT.map(normColHeader);
  const partN = ITEM_KW_PART.map(normColHeader);
  const exact = f.fixedCols.find((_, i) => exactN.some(k => normed[i] === k));
  if (exact) return exact;
  return (
    f.fixedCols.find((_, i) =>
      partN.some(k => normed[i].includes(k)) &&
      !normed[i].includes('code') && !normed[i].includes('كود') && !normed[i].includes('id')
    ) ?? f.fixedCols[1] ?? f.fixedCols[0] ?? ''
  );
}

export function detectPriceCol(f: { fixedCols: string[] }): string {
  const lower = f.fixedCols.map(c => c.toLowerCase().trim());
  return f.fixedCols.find((_, i) => PRICE_KW.some(k => lower[i].includes(k))) ?? '';
}

// ── تطبيع الأسماء: حذف لواحق البلد/المنشأ لتوحيد الكتابات المختلفة ──────────────
export function stripMergeSuffix(s: string): string {
  let n = s.trim();
  // مثال: "RAM PharmaJordanN/A" → "RAM"
  const RE_PHAR = /\s+(phar|pharma)\s*(iraq|iraqi|turkey|jordan|egypt|italy|canadian|cyprus|iran|lebanon|germany|france|syria)?\s*(n\/a)?\s*$/i;
  // مثال: "ALBALSAMIraqiN/A" أو "ALBALSAM Iraq N/A" → "ALBALSAM"
  const RE_COUNTRY = /\s*(iraq|iraqi|turkey|jordan|egypt|italy|canadian|cyprus|iran|lebanon|germany|france|syria)\s*(n\/a)?\s*$/i;
  const RE_NA = /\s*n\/a\s*$/i;
  let prev = '';
  while (n !== prev) {
    prev = n;
    n = n.replace(RE_PHAR, '').replace(RE_COUNTRY, '').replace(RE_NA, '').trim();
  }
  return n || s.trim(); // لا تُرجع نصاً فارغاً أبداً
}

export function normalMergeKey(s: string): string {
  return stripMergeSuffix(s)
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')              // حذف التشكيل
    .replace(/[آأإٱ]/g, 'ا')   // أ إ آ ٱ → ا
    .replace(/ة/g, 'ه')                        // ة → ه
    .replace(/ى/g, 'ي')                        // ى → ي
    .replace(/[.\-/\\,+()[\]'"]/g, ' ')
    .replace(/(\d)\s+(mg|mcg|ml|iu|gm|g\b|mm|cm|tabs?|caps?|amp)/gi,
      (_, n, u) => n + u.toLowerCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/** أعمدة لا تمثّل مذخراً حقيقياً (مذخر 1، اكسباير، تاريخ ...) */
const IGNORE_WH_PAT = /^مذخر\s*\d+$|^مخزن\s*\d+$|^warehouse\s*\d+$|اكسباير|اكسبير|expir|صلاحي|انتهاء|تاريخ/i;

// ── أسماء الأعمدة المُطبَّعة في المخرجات ─────────────────────────────────────────
export const COL_COMPANY = 'الشركة';
export const COL_ITEM = 'المادة';
export const COL_PRICE = 'السعر';

// ══════════════════════════════════════════════════════════════════════════════
//  صيغة المصفوفة: صف المناطق فوق صف المذاخر
// ══════════════════════════════════════════════════════════════════════════════

type WS = XLSX.WorkSheet;

const isNumLike = (s: string) => s !== '' && !isNaN(Number(String(s).replace(/,/g, '')));

/**
 * مفتاح لون تعبئة الخلية ('' = بلا لون).
 * يُستعمل لربط المنطقة بمذاخرها حين لا تكون خلية المنطقة مدموجة —
 * ففي هذه الملفات يكون اسم المنطقة وأسماء مذاخرها بنفس لون التعبئة.
 */
function fillKey(ws: WS, r: number, c: number): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cell = ws[XLSX.utils.encode_cell({ r, c })] as any;
  const st = cell?.s;
  if (!st) return '';
  const pattern = st.patternType ?? st.fill?.patternType;
  if (pattern === 'none') return '';
  const fg = st.fgColor ?? st.fill?.fgColor;
  if (!fg) return '';
  if (fg.rgb) {
    const hex = String(fg.rgb).toUpperCase().slice(-6);
    return (hex === 'FFFFFF' || hex === '000000') ? '' : `rgb:${hex}`;
  }
  if (fg.theme !== undefined) return `th:${fg.theme}:${fg.tint ?? 0}`;
  if (fg.indexed !== undefined) return `ix:${fg.indexed}`;
  return '';
}

interface MatrixArea { ci: number; label: string; region: string }
interface MatrixRow {
  company: string;
  item: string;
  price: string;
  vals: Record<number, string>;
  extras: Record<string, string>;
}
interface MatrixSheetResult {
  areas: MatrixArea[];
  rows: MatrixRow[];
  extraHeaders: string[];
  hasCompany: boolean;
  hasPrice: boolean;
}

/**
 * المدى الفعلي للبيانات: بعض الملفات تُصرّح بـ !ref أوسع بكثير من خلاياها
 * (أعمدة/صفوف فارغة محفوظة في الملف)، فنحسبه من عناوين الخلايا الموجودة فعلاً.
 */
function actualRange(ws: WS, declared: XLSX.Range): XLSX.Range {
  let maxR = declared.s.r, maxC = declared.s.c;
  for (const k of Object.keys(ws)) {
    if (k.charCodeAt(0) === 33) continue;   // مفاتيح '!' الخاصة
    const m = /^([A-Z]+)(\d+)$/.exec(k);
    if (!m) continue;
    const a = XLSX.utils.decode_cell(k);
    if (a.r > maxR) maxR = a.r;
    if (a.c > maxC) maxC = a.c;
  }
  return { s: declared.s, e: { r: Math.min(declared.e.r, maxR), c: Math.min(declared.e.c, maxC) } };
}

/** تحليل شيت واحد بصيغة المصفوفة → أعمدة مذاخر + صفوف بأدوار مُحدَّدة */
function parseMatrixSheet(ws: WS, sheetName: string, fileBase: string): MatrixSheetResult | null {
  const ref = ws['!ref'];
  if (!ref) return null;
  const range = actualRange(ws, XLSX.utils.decode_range(ref));
  const nCols = range.e.c + 1;

  const txt = (r: number, c: number): string => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell === undefined || cell.v === undefined || cell.v === null) return '';
    return String(cell.v).trim();
  };

  // ── 1) صف الرؤوس: أكثر صف «يشبه الرؤوس» وليس أكثر صف امتلاءً ────────────────
  // الاعتماد على عدد الخلايا المملوءة وحده كان يختار أحياناً صف بيانات في
  // الملفات العريضة، فتضيع المناطق ويصير كل شيء تحت منطقة واحدة.
  let hRowIdx = -1, bestScore = -Infinity;
  const lastScan = Math.min(range.s.r + 11, range.e.r);
  for (let r = range.s.r; r <= lastScan; r++) {
    let text = 0, num = 0, ident = 0, filled = 0;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const v = txt(r, c);
      if (!v) continue;
      filled++;
      if (isNumLike(v)) num++;
      else { text++; if (isIdentHeader(v)) ident++; }
    }
    if (filled < 3) continue;
    const score = text + ident * 5 - num * 3;
    if (score > bestScore) { bestScore = score; hRowIdx = r; }
  }
  if (hRowIdx < 0) return null;

  // ── 2) صف المناطق = الصف الذي فوق صف الرؤوس ───────────────────────────────
  const rRowIdx = hRowIdx - 1 >= range.s.r ? hRowIdx - 1 : -1;

  // مدى الدمج لكل عمود في صف المناطق (المفتاح = أي عمود داخل المدى)
  const mergeSpanAt = new Map<number, { s: number; e: number }>();
  if (rRowIdx >= 0) {
    for (const m of (ws['!merges'] ?? [])) {
      if (m.s.r <= rRowIdx && m.e.r >= rRowIdx) {
        for (let c = m.s.c; c <= m.e.c; c++) mergeSpanAt.set(c, { s: m.s.c, e: m.e.c });
      }
    }
  }

  const regionByCol: string[] = new Array(nCols).fill('');
  let bannerTitle = '';
  if (rRowIdx >= 0) {
    // لون العمود في منطقة الرؤوس: لون خلية صف المناطق، وإلا لون رأس المذخر
    const colFill = (c: number) => fillKey(ws, rRowIdx, c) || fillKey(ws, hRowIdx, c);

    // (أ) تقسيم الأعمدة إلى «كتل»: مدى الدمج إن وُجد، وإلا سلسلة متصلة بنفس اللون.
    //     اسم المنطقة قد يقع في أي عمود داخل كتلته (وليس في أولها) — ولهذا كان
    //     التمديد يميناً فقط يُسقط الأعمدة التي تسبق الاسم.
    const blocks: { s: number; e: number }[] = [];
    for (let c = range.s.c; c <= range.e.c; ) {
      const mSpan = mergeSpanAt.get(c);
      if (mSpan) {
        blocks.push({ s: Math.max(mSpan.s, range.s.c), e: Math.min(mSpan.e, range.e.c) });
        c = mSpan.e + 1;
        continue;
      }
      const key = colFill(c);
      let e = c;
      // سلسلة بنفس اللون، ما لم تدخل في مدى دمج
      while (e + 1 <= range.e.c && !mergeSpanAt.has(e + 1) && colFill(e + 1) === key) e++;
      blocks.push({ s: c, e });
      c = e + 1;
    }

    for (const blk of blocks) {
      // أسماء المناطق الواقعة داخل هذه الكتلة (بترتيب الأعمدة)
      const labels: { c: number; name: string }[] = [];
      for (let c = blk.s; c <= blk.e; c++) {
        const v = txt(rRowIdx, c);
        if (v && !isTotalHeader(v)) labels.push({ c, name: v });
      }
      if (!labels.length) continue;

      // خلية تغطي أعمدة التعريف أيضاً = عنوان الملف وليست منطقة
      if (blk.s <= 1 && (blk.e - blk.s + 1) >= nCols * 0.5) {
        if (!bannerTitle) bannerTitle = labels[0].name;
        continue;
      }

      const longs = labels.filter(l => l.name.length > 2);
      if (!longs.length) {
        // كل ما وُجد في هذه الكتلة شظايا حرف/حرفين («ح» وحدها بلا شريكتها
        // الطويلة — كتلة الألوان لم تلتقطها) — تركها بلا اسم أفضل من منطقة
        // مبتورة تتجمّد للأبد في StockWarehouse.region؛ تسقط لاحتياطي الملف.
        continue;
      }
      if (labels.length === 1 || longs.length <= 1) {
        // (ب) اسم واحد للكتلة كاملة. قد يكون مقسّماً على خليتين مثل
        //     «ح» + «الحارثية» — تُدمج مع تقديم الاسم الطويل على الحرف المفرد.
        const name = [...longs, ...labels.filter(l => l.name.length <= 2)]
          .map(l => l.name).join(' ').replace(/\s+/g, ' ').trim();
        for (let c = blk.s; c <= blk.e && c < nCols; c++) regionByCol[c] = name;
      } else {
        // (ج) عدة مناطق حقيقية بنفس اللون ومتلاصقة: كل اسم يبدأ مداه من عموده،
        //     والأول يبتلع الأعمدة التي تسبقه في الكتلة.
        for (let i = 0; i < labels.length; i++) {
          const start = i === 0 ? blk.s : labels[i].c;
          const end = i + 1 < labels.length ? labels[i + 1].c - 1 : blk.e;
          for (let c = start; c <= end && c < nCols; c++) regionByCol[c] = labels[i].name;
        }
      }
    }
  }

  // عمود تعريف (المادة/الشركة/السعر) لا يرث منطقة مهما كان ما فوقه
  for (let c = range.s.c; c <= range.e.c; c++) {
    if (regionByCol[c] && isIdentHeader(txt(hRowIdx, c))) regionByCol[c] = '';
  }

  // ── 3) تصنيف الأعمدة ───────────────────────────────────────────────────────
  /** هل بيانات العمود أرقام غالباً؟ null = لا بيانات إطلاقاً */
  const numericCol = (c: number): boolean | null => {
    let hits = 0, checked = 0;
    for (let r = hRowIdx + 1; r <= Math.min(hRowIdx + 15, range.e.r); r++) {
      const v = txt(r, c);
      if (!v) continue;
      checked++;
      if (isNumLike(v)) hits++;
    }
    return checked === 0 ? null : hits / checked >= 0.6;
  };

  const fallbackRegion = bannerTitle || fileBase || sheetName || 'مذاخر';
  const areas: MatrixArea[] = [];
  const labelSeen = new Map<string, number>();
  for (let c = range.s.c; c <= range.e.c; c++) {
    const h = txt(hRowIdx, c);
    if (!h) continue;                       // بلا رأس → ليس مذخراً
    if (isIdentHeader(h)) continue;         // عمود تعريف → ليس مذخراً أبداً
    if (isTotalHeader(h) || isExpiryHeader(h) || IGNORE_WH_PAT.test(h)) continue;
    const region = regionByCol[c];
    if (isTotalHeader(region)) continue;
    const num = numericCol(c);
    if (!region) { if (num !== true) continue; }  // بلا منطقة: يُقبل فقط لو كمّيات
    else if (num === false) continue;             // تحت منطقة لكنه نصّي → ليس كمّيات
    const reg = region || fallbackRegion;
    const dupKey = `${reg}||${h}`;
    const n = (labelSeen.get(dupKey) ?? 0) + 1;
    labelSeen.set(dupKey, n);
    areas.push({ ci: c, label: n > 1 ? `${h}_${n}` : h, region: reg });
  }
  // شيت بلا أعمدة مذاخر ليس شيت ستوك (ورقة ملاحظات مثلاً) — يُتجاهل
  if (!areas.length) return null;

  // ── 4) أدوار أعمدة التعريف (تقع يسار أول عمود مذخر) ────────────────────────
  const firstArea = areas[0].ci;
  const identCols: number[] = [];
  for (let c = range.s.c; c < firstArea; c++) {
    const h = txt(hRowIdx, c);
    if (!h || isTotalHeader(h) || isExpiryHeader(h)) continue;
    identCols.push(c);
  }

  const nrm = (c: number) => normColHeader(txt(hRowIdx, c));
  const COMPANY_EXACT = new Set(['الشركة', 'شركة', 'company', 'company name', 'vendor', 'supplier', 'brand', 'manufacturer', 'manufacture', 'principal', 'الوكيل', 'المجهز'].map(normColHeader));
  const CODE_EXACT = new Set(['item code', 'itemcode', 'code', 'الكود', 'كود', 'رمز', 'الرمز', 'barcode', 'sku', 'id'].map(normColHeader));
  const ITEM_EXACT = new Set(ITEM_KW_EXACT.map(normColHeader));
  const PRICE_EXACT = new Set(['price', 'السعر', 'سعر', 'unit price', 'سعر الوحدة', 'سعر الوحده', 'cost', 'التكلفة', 'تكلفة'].map(normColHeader));
  const SEQ_EXACT = new Set(['ت', '#', 'no', 'رقم', 'seq'].map(normColHeader));

  let companyCi = -1, itemCi = -1, priceCi = -1;
  let extras: number[] = [];
  for (const c of identCols) {
    const n = nrm(c);
    if (companyCi < 0 && COMPANY_EXACT.has(n)) { companyCi = c; continue; }
    if (itemCi < 0 && ITEM_EXACT.has(n)) { itemCi = c; continue; }
    if (priceCi < 0 && PRICE_EXACT.has(n)) { priceCi = c; continue; }
    if (SEQ_EXACT.has(n)) continue;
    extras.push(c);
  }
  // «item code» هو نفسه اسم الشركة حين لا يوجد عمود شركة صريح
  if (companyCi < 0) {
    const codeCol = identCols.find(c => CODE_EXACT.has(nrm(c)) || /(code|كود)$/.test(nrm(c)));
    if (codeCol !== undefined) { companyCi = codeCol; extras = extras.filter(c => c !== codeCol); }
  }
  // احتياطي لاسم الايتم: أول عمود تعريف نصّي غير مستهلك
  if (itemCi < 0) {
    const cand = extras.find(c => numericCol(c) !== true) ?? extras[0];
    if (cand !== undefined) { itemCi = cand; extras = extras.filter(c => c !== cand); }
  }

  // رأس «price» مدموج على خليتين: الأولى نص العملة (IQD) والثانية الرقم
  let priceValCi = priceCi;
  if (priceCi >= 0 && numericCol(priceCi) === false) {
    const next = priceCi + 1;
    if (next < firstArea && !txt(hRowIdx, next) && numericCol(next) === true) priceValCi = next;
  }

  if (itemCi < 0) return null;

  // ── 5) صفوف البيانات ───────────────────────────────────────────────────────
  const rows: MatrixRow[] = [];
  for (let r = hRowIdx + 1; r <= range.e.r; r++) {
    const item = txt(r, itemCi);
    if (!item || isIdentHeader(item) || isTotalHeader(item)) continue;
    const company = companyCi >= 0 ? txt(r, companyCi) : '';
    if (isTotalHeader(company)) continue;
    const vals: Record<number, string> = {};
    for (const a of areas) vals[a.ci] = txt(r, a.ci);
    const extraVals: Record<string, string> = {};
    for (const c of extras) extraVals[txt(hRowIdx, c)] = txt(r, c);
    rows.push({
      company,
      item,
      price: priceValCi >= 0 ? txt(r, priceValCi) : '',
      vals,
      extras: extraVals,
    });
  }

  if (!rows.length) return null;

  return {
    areas,
    rows,
    extraHeaders: extras.map(c => txt(hRowIdx, c)).filter(Boolean),
    hasCompany: companyCi >= 0,
    hasPrice: priceValCi >= 0,
  };
}

/**
 * قراءة ملف ستوك بصيغة المصفوفة — يقرأ **كل** الشيتات ويدمجها في ملف واحد
 * (الشيتات الإضافية كانت تُهمَل سابقاً فتضيع بياناتها).
 * هذا هو الاحتياطي النهائي: لا يُرجع 'NO' أبداً.
 */
export function parseStockMatrix(buffer: ArrayBuffer, filename: string): SalesFile | string {
  try {
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellStyles: true });
    if (!wb.SheetNames.length) return 'الملف لا يحتوي على أوراق عمل';
    const fileBase = filename.replace(/\.[^.]+$/, '');

    const parsed: MatrixSheetResult[] = [];
    for (const sn of wb.SheetNames) {
      const res = parseMatrixSheet(wb.Sheets[sn], sn, fileBase);
      if (res) parsed.push(res);
    }
    if (!parsed.length) return 'لم يتم العثور على صفوف بيانات';

    // اتحاد أعمدة المذاخر: المفتاح = المنطقة + اسم المذخر
    // نفس اسم المذخر تحت منطقتين مختلفتين = عمودان مستقلان، وهذا مقصود
    const colMap = new Map<string, ColMeta>();
    const sheetColKey: Map<number, string>[] = [];
    for (const sheet of parsed) {
      const map = new Map<number, string>();
      for (const a of sheet.areas) {
        const mapKey = `${a.region}||${a.label}`;
        if (!colMap.has(mapKey)) {
          colMap.set(mapKey, { key: `c${colMap.size}`, label: a.label, region: a.region, colIdx: -1 });
        }
        map.set(a.ci, colMap.get(mapKey)!.key);
      }
      sheetColKey.push(map);
    }
    const areaCols = [...colMap.values()];

    // الصفوف: تُدمج المكرّرات بين الشيتات فقط — داخل الشيت الواحد تبقى كما هي
    const rowMap = new Map<string, { obj: Record<string, string>; sheet: number }>();
    const out: Record<string, string>[] = [];
    parsed.forEach((sheet, si) => {
      const keyOf = sheetColKey[si];
      for (const r of sheet.rows) {
        const rowKey = `${normalMergeKey(r.company)}||${normalMergeKey(r.item)}`;
        const prev = rowMap.get(rowKey);
        let obj: Record<string, string>;
        if (prev && prev.sheet !== si) {
          obj = prev.obj;
        } else {
          obj = { [COL_COMPANY]: r.company, [COL_ITEM]: r.item };
          out.push(obj);
          rowMap.set(rowKey, { obj, sheet: si });
        }
        if (r.price && !toNum(obj[COL_PRICE] ?? '')) obj[COL_PRICE] = r.price;
        for (const [header, v] of Object.entries(r.extras)) {
          if (v && !obj[header]) obj[header] = v;
        }
        for (const [ci, v] of Object.entries(r.vals)) {
          const k = keyOf.get(Number(ci));
          if (!k) continue;
          obj[k] = String(toNum(obj[k] ?? '') + toNum(v));
        }
      }
    });

    // الخلايا الصفرية تُترك فارغة (أنظف في العرض وأصغر في التخزين)
    for (const obj of out) {
      for (const ac of areaCols) if (obj[ac.key] === '0') delete obj[ac.key];
    }

    const hasCompany = parsed.some(s => s.hasCompany);
    const hasPrice = parsed.some(s => s.hasPrice);
    const extraHeaders = [...new Set(parsed.flatMap(s => s.extraHeaders))];
    const fixedCols = [
      ...(hasCompany ? [COL_COMPANY] : []),
      COL_ITEM,
      ...(hasPrice ? [COL_PRICE] : []),
      ...extraHeaders,
    ];

    return {
      id: uid(),
      name: fileBase,
      uploadedAt: new Date().toISOString(),
      fixedCols,
      areaCols,
      rows: out,
      regions: [...new Set(areaCols.map(ac => ac.region).filter(Boolean))],
    };
  } catch (err) {
    console.error(err);
    return 'فشل قراءة الملف — تأكد أنه Excel أو CSV صحيح';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  مبيعات الموزّعين: عدة شيتات = محافظات
//  صف 0 = رؤوس: [كود الشركة | Description | الكمية | الكمية المجانية | Total Qty | Net Sale]
//  صفوف بعمود A فارغ = عناوين أقسام (اسم مندوب/منطقة) تُتخطى
// ══════════════════════════════════════════════════════════════════════════════
export function parseDistributorSales(buffer: ArrayBuffer, filename: string): SalesFile | 'NO' | string {
  try {
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    if (wb.SheetNames.length < 2) return 'NO';

    const firstRaw = XLSX.utils.sheet_to_json<unknown[]>(
      wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }
    );
    if (firstRaw.length < 3) return 'NO';

    // رؤوس صيغة الموزّعين قليلة العدد (~6 أعمدة). ملفات المصفوفة فيها عشرات
    // أعمدة المذاخر — لذا نحصر البحث في الأعمدة الأولى ونرفض الصفوف العريضة،
    // وإلا كفى وجود مذخر اسمه «مبيعات ...» ليخطف الملف من محلّل المصفوفة.
    const MAX_ROLE_CI = 9;
    let hRowIdx = -1;
    let companyColIdx = 0;
    let itemColIdx = -1;
    let totalQtyColIdx = -1;
    let netSaleColIdx = -1;

    for (let ri = 0; ri < Math.min(5, firstRaw.length); ri++) {
      const full = (firstRaw[ri] as unknown[]).map(v => String(v ?? '').trim().toLowerCase());
      if (full.filter(Boolean).length > 15) continue;   // صف عريض = مصفوفة مذاخر
      const row = full.slice(0, MAX_ROLE_CI + 1);
      const hasDesc = row.some(v =>
        v === 'description' || v.includes('المادة') || v.includes('الايتم') || v === 'item'
      );
      const hasQty = row.some(v => v === 'الكمية' || v === 'qty' || v === 'quantity');
      const hasNet = row.some(v => v.includes('net') || v.includes('صافي') || v.includes('مبيع'));
      if (hasDesc && (hasQty || hasNet)) {
        hRowIdx = ri;
        row.forEach((v, ci) => {
          if (ci === 0) companyColIdx = ci;
          if (v === 'description' || v.includes('المادة') || v.includes('الايتم') || v === 'item') itemColIdx = ci;
          if (v === 'total qty' || (v.includes('total') && v.includes('qty')) || v === 'مجموع الكمية') totalQtyColIdx = ci;
          if (v === 'الكمية' || v === 'qty') { if (totalQtyColIdx < 0) totalQtyColIdx = ci; }
          if (v.includes('net') || v.includes('صافي') || v.includes('مبيع')) netSaleColIdx = ci;
        });
        break;
      }
    }

    if (hRowIdx < 0 || itemColIdx < 0) return 'NO';
    if (totalQtyColIdx < 0 && netSaleColIdx < 0) return 'NO';
    // عند وجود عمودَي الكمية وصافي المبيع معاً: تُخزَّن الكمية في أعمدة المناطق
    // ويُشتق سعر الوحدة = الصافي ÷ الكمية ليعمل عرض «قيمة مالية» بشكل صحيح.
    const hasBothCols = totalQtyColIdx >= 0 && netSaleColIdx >= 0;
    const valueColIdx = hasBothCols ? totalQtyColIdx : (netSaleColIdx >= 0 ? netSaleColIdx : totalQtyColIdx);

    const rowMap = new Map<string, Record<string, string>>();
    const areaCols: ColMeta[] = [];
    const qtyAccum: Record<string, number> = {};
    const netAccum: Record<string, number> = {};

    for (const sheetName of wb.SheetNames) {
      const raw = XLSX.utils.sheet_to_json<unknown[]>(
        wb.Sheets[sheetName], { header: 1, defval: '' }
      );
      if (raw.length < 2) continue;

      let shHRowIdx = hRowIdx;
      for (let ri = 0; ri < Math.min(5, raw.length); ri++) {
        const row = (raw[ri] as unknown[]).map(v => String(v ?? '').trim().toLowerCase()).slice(0, MAX_ROLE_CI + 1);
        if (row.some(v => v === 'description' || v.includes('المادة') || v.includes('الايتم'))
          && row.some(v => v === 'الكمية' || v.includes('net') || v === 'qty')) {
          shHRowIdx = ri; break;
        }
      }

      const cityKey = `dist_${areaCols.length}`;
      areaCols.push({ key: cityKey, label: sheetName, region: sheetName, colIdx: -1 });

      for (let ri = shHRowIdx + 1; ri < raw.length; ri++) {
        const arr = raw[ri] as unknown[];
        const company = String(arr[companyColIdx] ?? '').trim();
        if (!company) continue;                       // صف عنوان قسم
        const item = String(arr[itemColIdx] ?? '').trim();
        if (!item) continue;
        if (company.toLowerCase().includes('description') || company.toLowerCase() === 'الكمية') continue;

        const value = toNumAcc(arr[valueColIdx]);
        const netVal = hasBothCols ? toNumAcc(arr[netSaleColIdx]) : 0;

        const rowKey = `${normalMergeKey(company)}||${normalMergeKey(item)}`;
        if (!rowMap.has(rowKey)) {
          rowMap.set(rowKey, { [COL_COMPANY]: stripMergeSuffix(company), [COL_ITEM]: item });
        }
        const obj = rowMap.get(rowKey)!;
        obj[cityKey] = String(toNumAcc(obj[cityKey] ?? '') + value);

        if (hasBothCols) {
          qtyAccum[rowKey] = (qtyAccum[rowKey] ?? 0) + value;
          netAccum[rowKey] = (netAccum[rowKey] ?? 0) + netVal;
        }
      }
    }

    if (hasBothCols) {
      for (const [rk, obj] of rowMap) {
        const totalQty = qtyAccum[rk] ?? 0;
        const totalNet = netAccum[rk] ?? 0;
        if (totalQty > 0 && totalNet > 0) obj[COL_PRICE] = String(totalNet / totalQty);
      }
    }

    if (rowMap.size === 0) return 'لم يتم العثور على بيانات في الملف';

    return {
      id: uid(),
      name: filename.replace(/\.[^.]+$/, ''),
      uploadedAt: new Date().toISOString(),
      fixedCols: hasBothCols ? [COL_COMPANY, COL_ITEM, COL_PRICE] : [COL_COMPANY, COL_ITEM],
      areaCols,
      rows: [...rowMap.values()],
      regions: wb.SheetNames,
    };
  } catch (err) {
    console.error(err);
    return 'فشل قراءة الملف';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ستوك متعدّد الشيتات: الملف = منطقة واحدة، والشيت = شركة
//  صف 0 = عنوان، صف 1 = رؤوس (المادة في العمود A، أسماء المذاخر في B فما بعد)
// ══════════════════════════════════════════════════════════════════════════════
export function parseMultiSheetStock(buffer: ArrayBuffer, filename: string): SalesFile | 'NO' | string {
  try {
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    if (!wb.SheetNames.length) return 'NO';

    const firstRaw = XLSX.utils.sheet_to_json<unknown[]>(
      wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }
    );
    if (firstRaw.length < 3) return 'NO';

    const hRow = (firstRaw[1] ?? []) as string[];
    const titleRow = (firstRaw[0] ?? []) as string[];

    // ── شروط صارمة لتمييز هذه الصيغة عن صيغة المصفوفة ──────────────────────
    // (كان الشرط السابق `col0.includes('item')` يتحقّق أيضاً على «item code»،
    //  فيخطف ملفات المصفوفة: فتصير الشركة = اسم الشيت، والمادة = كود الشركة،
    //  ويصير Item و price ضمن المذاخر، وتختفي المناطق تحت اسم واحد.)
    const col0 = normColHeader(String(hRow[0] ?? ''));
    const ITEM_EXACT = new Set(ITEM_KW_EXACT.map(normColHeader));
    if (!ITEM_EXACT.has(col0)) return 'NO';                       // A = اسم المادة تماماً
    if (/(code|كود|رمز|id)/.test(col0)) return 'NO';              // وليس كود/رمز
    // صف 0 عنوان (خلية أو خليتان) وليس صف مناطق فيه عدة أسماء
    if (titleRow.map(v => String(v ?? '').trim()).filter(Boolean).length > 2) return 'NO';
    // B فما بعد = أسماء مذاخر، فإن كان أيّها عمود تعريف فهذه صيغة مصفوفة
    for (let ci = 1; ci < Math.min(4, hRow.length); ci++) {
      if (isIdentHeader(String(hRow[ci] ?? ''))) return 'NO';
    }

    // اسم المنطقة من صف العنوان (صف 0)
    const regionName = titleRow.map(v => String(v ?? '').trim()).find(Boolean)
      || filename.replace(/\.[^.]+$/, '');

    // قائمة المذاخر الرئيسية من رؤوس الشيت الأول
    interface WHEntry { ci: number; name: string; key: string }
    const masterWH: WHEntry[] = [];
    for (let ci = 1; ci < hRow.length; ci++) {
      const name = String(hRow[ci] ?? '').trim();
      if (!name || IGNORE_WH_PAT.test(name) || isTotalHeader(name)) continue;
      masterWH.push({ ci, name, key: `w${masterWH.length}` });
    }
    if (!masterWH.length) return 'NO';

    const areaCols: ColMeta[] = masterWH.map(wc => ({
      key: wc.key, label: wc.name, region: regionName, colIdx: wc.ci,
    }));

    const allRows: Record<string, string>[] = [];

    for (const sheetName of wb.SheetNames) {
      const raw = XLSX.utils.sheet_to_json<unknown[]>(
        wb.Sheets[sheetName], { header: 1, defval: '' }
      );
      if (raw.length < 3) continue;

      // خريطة اسم→عمود لهذا الشيت (ترتيب الأعمدة قد يختلف بين الشيتات)
      const sheetHRow = raw[1] as string[];
      const nameToCI: Record<string, number> = {};
      for (let ci = 1; ci < sheetHRow.length; ci++) {
        const name = String(sheetHRow[ci] ?? '').trim();
        if (!name || IGNORE_WH_PAT.test(name)) continue;
        nameToCI[name] = ci;
      }

      for (let ri = 2; ri < raw.length; ri++) {
        const arr = raw[ri] as string[];
        const itemName = String(arr[0] ?? '').trim();
        if (!itemName) continue;

        const obj: Record<string, string> = { [COL_COMPANY]: sheetName, [COL_ITEM]: itemName };
        for (const wc of masterWH) {
          const srcCi = nameToCI[wc.name];
          obj[wc.key] = srcCi !== undefined ? String(arr[srcCi] ?? '') : '';
        }
        allRows.push(obj);
      }
    }

    if (!allRows.length) return 'لم يتم العثور على بيانات في الملف';

    return {
      id: uid(),
      name: filename.replace(/\.[^.]+$/, ''),
      uploadedAt: new Date().toISOString(),
      fixedCols: [COL_COMPANY, COL_ITEM],
      areaCols,
      rows: allRows,
      regions: [regionName],
    };
  } catch (err) {
    console.error(err);
    return 'فشل قراءة الملف';
  }
}

/** نقطة الدخول الوحيدة: يجرّب الصيغ بالترتيب وينتهي بمحلّل المصفوفة */
export function parseStockFile(buffer: ArrayBuffer, filename: string): SalesFile | string {
  const r1 = parseDistributorSales(buffer, filename);
  if (r1 !== 'NO') return r1;
  const r2 = parseMultiSheetStock(buffer, filename);
  if (r2 !== 'NO') return r2;
  return parseStockMatrix(buffer, filename);
}

// ══════════════════════════════════════════════════════════════════════════════
//  دمج عدة ملفات في ملف واحد
// ══════════════════════════════════════════════════════════════════════════════
export function buildMergedFile(selectedFiles: SalesFile[], names: string[]): SalesFile {
  // اتحاد أعمدة المذاخر مع الحفاظ على منطقة كل عمود كما جاءت من التحليل،
  // والمفتاح = المنطقة الأصلية + اسم المذخر لتفادي الخلط بين الملفات.
  const colMap = new Map<string, ColMeta>();
  for (const f of selectedFiles) {
    for (const ac of f.areaCols) {
      const region = (ac.region && ac.region.trim()) ? ac.region.trim() : f.name;
      const mapKey = `${region}||${ac.label}`;
      if (!colMap.has(mapKey)) {
        colMap.set(mapKey, { key: `m_${colMap.size}`, label: ac.label, region, colIdx: -1 });
      }
    }
  }
  const mergedAreaCols = [...colMap.values()];
  const allRegions = [...new Set(mergedAreaCols.map(c => c.region).filter(Boolean))];

  // المرحلة 1: بناء الأسماء المرجعية — أقصر صيغة نظيفة تفوز
  const canonCompany = new Map<string, string>();
  const canonItem = new Map<string, string>();
  function updateCanon(map: Map<string, string>, raw: string) {
    const key = normalMergeKey(raw);
    const clean = stripMergeSuffix(raw);
    if (!map.has(key) || clean.length < map.get(key)!.length) map.set(key, clean);
  }
  for (const f of selectedFiles) {
    const cCol = detectCompanyCol(f);
    const iCol = detectItemNameCol(f);
    for (const row of f.rows) {
      const rawC = cCol ? String(row[cCol] ?? '').trim() : f.name;
      const rawI = iCol ? String(row[iCol] ?? '').trim() : '';
      if (!rawI) continue;
      updateCanon(canonCompany, rawC);
      updateCanon(canonItem, rawI);
    }
  }

  // المرحلة 2: تجميع الصفوف حسب (الشركة، المادة) المرجعية وجمع قيم المذاخر
  const rowMap = new Map<string, Record<string, string>>();
  for (const f of selectedFiles) {
    const cCol = detectCompanyCol(f);
    const iCol = detectItemNameCol(f);
    const pCol = detectPriceCol(f);
    const acKeyToMerged = new Map<string, string>();
    for (const ac of f.areaCols) {
      const region = (ac.region && ac.region.trim()) ? ac.region.trim() : f.name;
      const m = colMap.get(`${region}||${ac.label}`);
      if (m) acKeyToMerged.set(ac.key, m.key);
    }
    const fileRegions = [...new Set(f.areaCols.map(ac =>
      (ac.region && ac.region.trim()) ? ac.region.trim() : f.name
    ))];
    for (const row of f.rows) {
      const rawC = cCol ? String(row[cCol] ?? '').trim() : f.name;
      const rawI = iCol ? String(row[iCol] ?? '').trim() : '';
      if (!rawI) continue;
      const company = canonCompany.get(normalMergeKey(rawC)) ?? stripMergeSuffix(rawC);
      const item = canonItem.get(normalMergeKey(rawI)) ?? stripMergeSuffix(rawI);
      const rowKey = `${normalMergeKey(rawC)}||${normalMergeKey(rawI)}`;
      if (!rowMap.has(rowKey)) {
        rowMap.set(rowKey, { [COL_COMPANY]: company, [COL_ITEM]: item, '_regions': fileRegions.join(',') });
      } else {
        const obj = rowMap.get(rowKey)!;
        const seen = new Set(obj['_regions'].split(',').filter(Boolean));
        for (const r of fileRegions) seen.add(r);
        obj['_regions'] = [...seen].join(',');
      }
      const obj = rowMap.get(rowKey)!;
      for (const ac of f.areaCols) {
        const mk = acKeyToMerged.get(ac.key);
        if (mk) obj[mk] = String(toNum(obj[mk] ?? '') + toNum(String(row[ac.key] ?? '')));
      }
      if (pCol && !obj[COL_PRICE] && toNum(String(row[pCol] ?? '')) > 0) {
        obj[COL_PRICE] = String(row[pCol]);
      }
    }
  }

  const hasPriceInAnyFile = selectedFiles.some(f => detectPriceCol(f));

  const _mergeDebug = selectedFiles.map(f => ({
    file: f.name,
    companyCol: detectCompanyCol(f) || '(لم يُعثر — استخدم اسم الملف)',
    itemCol: detectItemNameCol(f),
    rows: f.rows.length,
  }));

  const shortNames = names.map(n => n.length > 12 ? n.slice(0, 12) + '…' : n).join(' + ');
  return {
    id: uid(),
    name: `دمج: ${shortNames}`,
    uploadedAt: new Date().toISOString(),
    fixedCols: hasPriceInAnyFile ? [COL_COMPANY, COL_ITEM, COL_PRICE] : [COL_COMPANY, COL_ITEM],
    areaCols: mergedAreaCols,
    rows: [...rowMap.values()],
    regions: allRegions,
    sourceFileIds: selectedFiles.map(f => f.id),
    _mergeDebug,
  };
}
