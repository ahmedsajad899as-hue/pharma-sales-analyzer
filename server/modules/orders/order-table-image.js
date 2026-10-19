// ════════════════════════════════════════════════════════════════════════════
// order-table-image.js — صورة PNG «كشف» لجدول تحليل الطلبيات تُرسَل للكروب عند
// كتابة «كشف» (bot-order-flow.js). الشكل يحاكي شبكة المراجعة في التطبيق
// (ManualSalesModal): نفس الأعمدة وترتيبها، وخانات الفاتورة (الطلبية/المذخر/رقم
// الفاتورة/التاريخ) مدموجة عمودياً على أصنافها، وألوان محايدة رسمية.
//
// SVG يُبنى نصّاً ثم يُرسَم بـ@resvg/resvg-js (Rust أصلي، بلا متصفح ولا canvas —
// السيرفر 951MB RAM). الخط مُضمَّن (Vazirmatn، OFL) وresvg يتولّى تشكيل العربية.
//
// فخّ اتجاه السطر: resvg يأخذ اتجاه السطر من أول حرف قوي فيه (RLM لا يكفي) —
// فالعنوان والتذييل يبدآن بكلمة عربية ولا ينتهيان بلاتيني، وإلا انقلب ترتيبهما.
// ولا رموز تعبيرية: الخط لا يحملها فتُرسَم مربعات فارغة.
// ════════════════════════════════════════════════════════════════════════════

import path from 'path';
import { fileURLToPath } from 'url';
import { repCoreName } from '../../lib/repNameMatch.js';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
const FONT_FILES = ['Vazirmatn-Regular.ttf', 'Vazirmatn-Bold.ttf'].map(f => path.join(FONT_DIR, f));

// حدّ تلكرام: العرض+الطول ≤ 10000 بكسل. «كشف» يقسّم الطلبيات الكثيرة صوراً بهذا
// الحدّ (paginateOrderRows)، وما يزيد في صورة واحدة يُذكر عدداً.
export const MAX_ROWS = 40;

const PAD = 22;
const FS = 13.5;          // حجم نصّ الخلايا
const LINE = 19;          // ارتفاع السطر داخل الخلية
const CELL_PAD_Y = 9;
const HEAD_H = 36;

const C = {
  text: '#1e293b', strong: '#0f172a', muted: '#64748b', head: '#475569',
  headBg: '#f1f5f9', invBg: '#f8fafc', grid: '#e2e8f0', groupLine: '#94a3b8', warn: '#b45309',
};

// الأعمدة من اليمين لليسار — نفس ترتيب شبكة المراجعة. inv = خانة فاتورة مدموجة.
const COLS = [
  { key: 'order',         label: 'ف',              w: 54,  inv: true, center: true },
  { key: 'warehouse',     label: 'المذخر',          w: 128, inv: true },
  { key: 'invoiceNumber', label: 'رقم الفاتورة',    w: 96,  inv: true, center: true },
  { key: 'date',          label: 'التاريخ',         w: 96,  inv: true, center: true },
  { key: 'item',          label: 'المادة',          w: 236 },
  { key: 'company',       label: 'الشركة',          w: 86,  center: true },
  { key: 'quantity',      label: 'الكمية',          w: 62,  num: true },
  { key: 'unitPrice',     label: 'سعر الوحدة',      w: 88,  num: true },
  { key: 'total',         label: 'السعر الكلي',     w: 104, num: true },
  { key: 'bonus',         label: 'البونص',          w: 62,  num: true },
  { key: 'pharmacy',      label: 'الصيدلية',        w: 170 },
  { key: 'area',          label: 'المنطقة',         w: 118 },
  { key: 'scientificRep', label: 'المندوب العلمي',   w: 150 },
];
const TABLE_W = COLS.reduce((a, c) => a + c.w, 0);
const W = TABLE_W + 2 * PAD;

const escXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtNum = (v) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '—';
  const [i, f] = String(Math.round(n * 100) / 100).split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (f ? `,${f}` : '');
};
const HAS_AR = /[؀-ۿ]/;

/** نصّ عربي يحمل ذيلاً لاتينياً مكرَّراً («مذخر طريق السلام Tareeq Al-Salam») ⇒ العربي فقط. */
function arabicOnly(s) {
  const t = String(s ?? '').trim();
  if (!HAS_AR.test(t)) return t;
  return t.replace(/(\s+[A-Za-z][A-Za-z.\-']*)+\s*$/, '').trim();
}

/** تقسيم نصّ لأسطر بعرض تقريبي (لا قياس خطوط في SVG الخام): الحرف ≈ 0.58 من الحجم. */
function wrap(text, widthPx, maxLines, size = FS) {
  const s = String(text ?? '').trim();
  if (!s) return [''];
  const max = Math.max(4, Math.floor(widthPx / (size * 0.58)));
  const words = s.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w.length > max ? w.slice(0, max - 1) + '…' : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1];
    kept[maxLines - 1] = (last.length >= max ? last.slice(0, max - 1) : last) + '…';
    return kept;
  }
  return lines;
}

/** خلية نصّ (سطر أو أكثر) متوسّطة عمودياً داخل [top, top+h]. */
function cellText(lines, { xRight, w, top, h, center = false, bold = false, color = C.text, size = FS }) {
  const total = lines.length * LINE;
  const y0 = top + (h - total) / 2 + LINE * 0.72;
  const x = center ? xRight - w / 2 : xRight - 8;
  const anchor = center ? 'middle' : 'end';
  return lines.map((ln, k) =>
    `<text x="${x}" y="${(y0 + k * LINE).toFixed(1)}" text-anchor="${anchor}" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="${color}">${escXml(ln)}</text>`,
  ).join('');
}

/** فاتورة واحدة = صفوف متتالية بنفس (الطلبية، المذخر، رقم الفاتورة، التاريخ). */
function groupInvoices(rows) {
  const groups = [];
  for (const r of rows) {
    const k = [r._orderId, r.warehouse, r.invoiceNumber, r.date].map(v => String(v ?? '').trim()).join('|');
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.rows.push(r); else groups.push({ key: k, r, rows: [r] });
  }
  return groups;
}

const rowTotal = (r) => (r.total != null && r.total !== '' && Number.isFinite(Number(r.total)))
  ? Number(r.total) : (Number(r.quantity) || 0) * (Number(r.unitPrice) || 0);

/**
 * يبني SVG الكشف.
 * @param {object[]} rows  صفوف (item, quantity, bonus, unitPrice, total, company, pharmacy, area, warehouse, invoiceNumber, date, scientificRep, _orderId)
 * @param {{ title?: string, footer?: string }} [o]
 */
export function buildOrderTableSvg(rows, { title = 'كشف الطلبيات', footer = '' } = {}) {
  const shown = rows.slice(0, MAX_ROWS);
  const groups = groupInvoices(shown);
  const parts = [];
  let y = PAD;
  const right = W - PAD;

  // ── العنوان + سطر ملخّص ──
  const orders = new Set(rows.map(r => r._orderId).filter(v => v != null)).size;
  const grand = rows.reduce((a, r) => a + (rowTotal(r) || 0), 0);
  const now = new Date(Date.now() + 3 * 3600_000).toISOString(); // توقيت بغداد
  parts.push(`<text x="${right}" y="${y + 22}" text-anchor="end" font-size="21" font-weight="700" fill="${C.strong}">${escXml(title)}</text>`);
  y += 34;
  const summary = [
    orders ? `عدد الطلبيات: ${orders}` : null,
    `عدد الأصناف: ${rows.length}`,
    `المجموع: ${fmtNum(grand)} د.ع`,
    `التاريخ: ${now.slice(0, 10)} ${now.slice(11, 16)}`,
  ].filter(Boolean).join('     |     ');
  parts.push(`<text x="${right}" y="${y + 14}" text-anchor="end" font-size="13" fill="${C.muted}">${escXml(summary)}</text>`);
  y += 30;

  // ── رأس الجدول ──
  const tableTop = y;
  parts.push(`<rect x="${PAD}" y="${y}" width="${TABLE_W}" height="${HEAD_H}" fill="${C.headBg}"/>`);
  let x = right;
  for (const c of COLS) {
    parts.push(cellText([c.label], { xRight: x, w: c.w, top: y, h: HEAD_H, center: c.center || c.num, bold: true, color: C.head, size: 12.5 }));
    x -= c.w;
  }
  y += HEAD_H;
  parts.push(`<line x1="${PAD}" y1="${y}" x2="${right}" y2="${y}" stroke="${C.groupLine}"/>`);

  // ── الصفوف ──
  const colX = new Map();
  { let cx = right; for (const c of COLS) { colX.set(c.key, cx); cx -= c.w; } }
  const invW = COLS.filter(c => c.inv).reduce((a, c) => a + c.w, 0);

  groups.forEach((g, gi) => {
    const gTop = y;
    // ارتفاع كل صف = أكثر خلاياه أسطراً (حتى سطرين).
    const prepared = g.rows.map(r => {
      const rep = repCoreName(String(r.scientificRep ?? '').trim());
      const cells = {
        item:          wrap(r.item || '—', 236 - 16, 2),
        company:       wrap(r.company || '—', 86 - 12, 1),
        quantity:      [fmtNum(r.quantity)],
        unitPrice:     [fmtNum(r.unitPrice)],
        total:         [rowTotal(r) ? fmtNum(rowTotal(r)) : '—'],
        bonus:         [r.bonus ? fmtNum(r.bonus) : '—'],
        pharmacy:      wrap(arabicOnly(r.pharmacy) || '—', 170 - 16, 2),
        area:          wrap(arabicOnly(r.area) || '—', 118 - 16, 2),
        scientificRep: wrap(rep || 'غير محدد', 150 - 16, 2),
      };
      const lines = Math.max(...Object.values(cells).map(l => l.length));
      return { r, rep, cells, h: lines * LINE + 2 * CELL_PAD_Y };
    });
    const inv = {
      order:         [g.r._orderId != null ? `#${g.r._orderId}` : '—'],
      warehouse:     wrap(arabicOnly(g.r.warehouse) || '—', 128 - 16, 3),
      invoiceNumber: wrap(String(g.r.invoiceNumber ?? '').trim() || '—', 96 - 12, 2),
      date:          [String(g.r.date ?? '').trim() || '—'],
    };
    const invLines = Math.max(...Object.values(inv).map(l => l.length));
    const rowsH = prepared.reduce((a, p) => a + p.h, 0);
    const gH = Math.max(rowsH, invLines * LINE + 2 * CELL_PAD_Y);
    // إن كانت خانات الفاتورة أطول من أصنافها يُضاف الفرق لآخر صف.
    if (gH > rowsH) prepared[prepared.length - 1].h += gH - rowsH;

    // خلفية خانات الفاتورة المدموجة
    parts.push(`<rect x="${right - invW}" y="${gTop}" width="${invW}" height="${gH}" fill="${C.invBg}"/>`);
    for (const c of COLS.filter(c => c.inv)) {
      parts.push(cellText(inv[c.key], { xRight: colX.get(c.key), w: c.w, top: gTop, h: gH, center: c.center, bold: c.key === 'order', color: c.key === 'order' ? C.strong : C.text }));
    }

    let ry = gTop;
    prepared.forEach((p, k) => {
      for (const c of COLS.filter(c => !c.inv)) {
        const warn = c.key === 'scientificRep' && !p.rep;
        parts.push(cellText(p.cells[c.key], {
          xRight: colX.get(c.key), w: c.w, top: ry, h: p.h,
          center: c.center || c.num, bold: c.key === 'item',
          color: warn ? C.warn : c.key === 'item' ? C.strong : C.text,
        }));
      }
      ry += p.h;
      if (k < prepared.length - 1) {
        parts.push(`<line x1="${PAD}" y1="${ry}" x2="${right - invW}" y2="${ry}" stroke="${C.grid}"/>`);
      }
    });
    y = gTop + gH;
    // فاصل أوضح بين فاتورة وأخرى — نفس خط شبكة المراجعة.
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${right}" y2="${y}" stroke="${gi < groups.length - 1 ? C.groupLine : C.grid}"/>`);
  });

  // خطوط الأعمدة العمودية الخفيفة + إطار الجدول
  { let cx = right; for (const c of COLS.slice(0, -1)) { cx -= c.w; parts.push(`<line x1="${cx}" y1="${tableTop}" x2="${cx}" y2="${y}" stroke="${C.grid}"/>`); } }
  parts.push(`<rect x="${PAD}" y="${tableTop}" width="${TABLE_W}" height="${y - tableTop}" fill="none" stroke="${C.grid}"/>`);

  y += 14;
  if (rows.length > shown.length) {
    parts.push(`<text x="${right}" y="${y + 14}" text-anchor="end" font-size="13" fill="${C.muted}">${escXml(`و ${rows.length - shown.length} صنف آخر — راجعها في التطبيق`)}</text>`);
    y += 24;
  }
  if (footer) {
    parts.push(`<text x="${right}" y="${y + 14}" text-anchor="end" font-size="12.5" fill="${C.muted}">${escXml(footer)}</text>`);
    y += 24;
  }
  const H = Math.ceil(y + PAD - 8);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Vazirmatn">`
    + `<rect width="100%" height="100%" fill="#ffffff"/>${orderLayers(parts)}</svg>`;
}

/** الخلفيات (rect) أولاً ثم الخطوط ثم النصوص — كي لا تغطّي خلفيةٌ نصاً رُسم قبلها. */
function orderLayers(parts) {
  const rank = (p) => (p.startsWith('<rect') ? 0 : p.startsWith('<line') ? 1 : 2);
  return parts.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p).join('');
}

/**
 * يقسّم صفوف عدة طلبيات صفحاتٍ لا تتجاوز MAX_ROWS، بلا شطر طلبية بين صفحتين
 * (إلا طلبية أطول من الحدّ وحدها). الصفوف تحمل _orderId.
 */
export function paginateOrderRows(rows) {
  const byOrder = [];
  for (const r of rows) {
    const last = byOrder[byOrder.length - 1];
    if (last && last.id === r._orderId) last.rows.push(r); else byOrder.push({ id: r._orderId, rows: [r] });
  }
  const pages = [];
  let cur = [];
  for (const o of byOrder) {
    if (cur.length && cur.length + o.rows.length > MAX_ROWS) { pages.push(cur); cur = []; }
    for (let i = 0; i < o.rows.length; i += MAX_ROWS) {
      const chunk = o.rows.slice(i, i + MAX_ROWS);
      if (cur.length && cur.length + chunk.length > MAX_ROWS) { pages.push(cur); cur = []; }
      cur.push(...chunk);
    }
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/** PNG جاهز للإرسال. يرمي إن تعذّر الرسم — المستدعي يتعامل (الصورة تحسين لا شرط). */
export async function renderOrderTablePng(rows, opts) {
  const { Resvg } = await import('@resvg/resvg-js'); // كسول: لا يُحمَّل إلا عند الحاجة
  const svg = buildOrderTableSvg(rows, opts);
  const r = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: 1.6 },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Vazirmatn' },
  });
  return r.render().asPng();
}
