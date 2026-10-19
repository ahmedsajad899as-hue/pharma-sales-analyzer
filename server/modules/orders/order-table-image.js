// ════════════════════════════════════════════════════════════════════════════
// order-table-image.js — صورة PNG لجدول تحليل الطلبية تُرسَل للكروب فور القراءة
// (طلب صاحب المشروع 2026-10-19): كي يرى المندوبون كيف قُرئت طلبيتهم وينبّهوا على
// الخطأ قبل تدقيق المدير.
//
// SVG يُبنى نصّاً ثم يُرسَم بـ@resvg/resvg-js (Rust أصلي، بلا متصفح ولا canvas —
// السيرفر 951MB RAM). الخط مُضمَّن (Vazirmatn، OFL) فلا اعتماد على خطوط النظام،
// وresvg يتولّى تشكيل الحروف العربية واتجاهها.
// ════════════════════════════════════════════════════════════════════════════

import path from 'path';
import { fileURLToPath } from 'url';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
const FONT_FILES = ['Vazirmatn-Regular.ttf', 'Vazirmatn-Bold.ttf'].map(f => path.join(FONT_DIR, f));

const W = 980;          // عرض الصورة بالوحدات (تُرسَم بضعفها للوضوح)
const PAD = 18;
const ROW_H = 30;
const MAX_ROWS = 40;    // صورة بطول معقول؛ الباقي يُذكر عدداً

const escXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// نصّ فيه عربي يُسبَق بعلامة RLM كي يكون اتجاه الفقرة يميناً→يسار: بدونها يبدأ
// «Yahya S تحليل…» بحرف لاتيني فينقلب ترتيب السطر كله. اللاتيني الخالص يبقى LTR.
const esc = (s) => (/[؀-ۿ]/.test(String(s ?? '')) ? '‏' : '') + escXml(s);
const fmtNum = (v) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '—';
  const [i, f] = String(Math.round(n * 100) / 100).split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (f ? `,${f}` : '');
};

/** قصّ تقريبي بحسب العرض (لا قياس خطوط في SVG الخام): عرض الحرف ≈ 0.56 من الحجم. */
function fit(text, widthPx, size) {
  const s = String(text ?? '').trim();
  const max = Math.max(3, Math.floor(widthPx / (size * 0.56)));
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// الأعمدة من اليمين لليسار (الواجهة عربية). w = العرض، num = رقمي (يُوسَّط).
const COLS = [
  { key: 'n',             label: '#',              w: 34,  num: true },
  { key: 'item',          label: 'المادة',          w: 270 },
  { key: 'quantity',      label: 'الكمية',          w: 64,  num: true },
  { key: 'bonus',         label: 'البونص',          w: 60,  num: true },
  { key: 'unitPrice',     label: 'السعر',           w: 86,  num: true },
  { key: 'total',         label: 'الإجمالي',         w: 104, num: true },
  { key: 'company',       label: 'الشركة',          w: 96 },
  { key: 'scientificRep', label: 'المندوب العلمي',   w: 0 },   // الباقي
];
{
  const used = COLS.reduce((a, c) => a + c.w, 0);
  COLS[COLS.length - 1].w = W - 2 * PAD - used;
}

/** فاتورة واحدة = صفوف بنفس (الصيدلية، المنطقة، المذخر، رقم الفاتورة). */
function groupInvoices(rows) {
  const groups = [];
  const byKey = new Map();
  for (const r of rows) {
    const k = [r.pharmacy, r.area, r.warehouse, r.invoiceNumber].map(v => String(v ?? '').trim()).join('|');
    if (!byKey.has(k)) { const g = { r, rows: [] }; byKey.set(k, g); groups.push(g); }
    byKey.get(k).rows.push(r);
  }
  return groups;
}

/**
 * يبني SVG الجدول.
 * @param {object[]} rows  صفوف الطلبية بعد المطابقة (item, quantity, bonus, unitPrice, total, company, pharmacy, area, warehouse, scientificRep)
 * @param {{ title?: string, footer?: string }} [o]
 */
// تنبيه: resvg يأخذ اتجاه السطر من أول حرف قوي فيه، وRLM لا يكفي — فالعنوان والتذييل
// يبدآن بكلمة عربية ولا ينتهيان بلاتيني (وإلا انقلب ترتيب السطر).
export function buildOrderTableSvg(rows, { title = 'تحليل الطلبية', footer = '' } = {}) {
  const shown = rows.slice(0, MAX_ROWS);
  const groups = groupInvoices(shown);
  const parts = [];
  let y = PAD;

  // العنوان
  parts.push(`<text x="${W - PAD}" y="${y + 22}" text-anchor="end" font-size="20" font-weight="700" fill="#0f172a">${esc(title)}</text>`);
  y += 40;

  let n = 0;
  let grand = 0;
  for (const g of groups) {
    // ترويسة الفاتورة: الصيدلية — المنطقة · المذخر · رقم الفاتورة
    const h = g.r;
    // بلا رموز تعبيرية: الخط المضمَّن لا يحملها فتُرسَم مربعات فارغة.
    const head = [
      `الصيدلية: ${h.pharmacy || 'غير مقروءة'}`,
      `المنطقة: ${h.area || 'غير محددة'}`,
      h.warehouse ? `المذخر: ${h.warehouse}` : null,
      h.invoiceNumber ? `الفاتورة: ${h.invoiceNumber}` : null,
    ].filter(Boolean).join('   |   ');
    parts.push(`<rect x="${PAD}" y="${y}" width="${W - 2 * PAD}" height="${ROW_H + 2}" rx="6" fill="#fef3c7"/>`);
    parts.push(`<text x="${W - PAD - 10}" y="${y + 21}" text-anchor="end" font-size="15" font-weight="700" fill="#78350f">${esc(fit(head, W - 2 * PAD - 20, 15))}</text>`);
    y += ROW_H + 6;

    // رأس الأعمدة
    let x = W - PAD;
    parts.push(`<rect x="${PAD}" y="${y}" width="${W - 2 * PAD}" height="${ROW_H}" fill="#e2e8f0"/>`);
    for (const c of COLS) {
      const tx = c.num ? x - c.w / 2 : x - 8;
      parts.push(`<text x="${tx}" y="${y + 20}" text-anchor="${c.num ? 'middle' : 'end'}" font-size="13" font-weight="700" fill="#334155">${esc(c.label)}</text>`);
      x -= c.w;
    }
    y += ROW_H;

    g.rows.forEach((r, i) => {
      n++;
      const total = r.total != null && r.total !== '' ? Number(r.total)
        : (Number(r.quantity) || 0) * (Number(r.unitPrice) || 0);
      if (Number.isFinite(total)) grand += total;
      const missingRep = !String(r.scientificRep ?? '').trim();
      const vals = {
        n: String(n),
        item: r.item || '—',
        quantity: fmtNum(r.quantity),
        bonus: r.bonus ? fmtNum(r.bonus) : '—',
        unitPrice: fmtNum(r.unitPrice),
        total: total ? fmtNum(total) : '—',
        company: r.company || '—',
        scientificRep: missingRep ? 'غير محدد' : r.scientificRep,
      };
      parts.push(`<rect x="${PAD}" y="${y}" width="${W - 2 * PAD}" height="${ROW_H}" fill="${i % 2 ? '#f8fafc' : '#ffffff'}"/>`);
      let cx = W - PAD;
      for (const c of COLS) {
        const tx = c.num ? cx - c.w / 2 : cx - 8;
        const warn = c.key === 'scientificRep' && missingRep;
        const color = warn ? '#b45309' : c.key === 'item' ? '#0f172a' : '#1e293b';
        const weight = c.key === 'item' ? 700 : 400;
        parts.push(`<text x="${tx}" y="${y + 20}" text-anchor="${c.num ? 'middle' : 'end'}" font-size="14" font-weight="${weight}" fill="${color}">${esc(fit(vals[c.key], c.w - 14, 14))}</text>`);
        cx -= c.w;
      }
      parts.push(`<line x1="${PAD}" y1="${y + ROW_H}" x2="${W - PAD}" y2="${y + ROW_H}" stroke="#e2e8f0"/>`);
      y += ROW_H;
    });
    y += 10;
  }

  // المجموع + ملاحظة
  const more = rows.length > shown.length ? `   (+${rows.length - shown.length} صنف آخر في التطبيق)` : '';
  parts.push(`<text x="${W - PAD}" y="${y + 18}" text-anchor="end" font-size="15" font-weight="700" fill="#0f172a">${esc(`عدد الأصناف: ${rows.length}   |   المجموع: ${fmtNum(grand)}${more}`)}</text>`);
  y += 30;
  if (footer) {
    parts.push(`<text x="${W - PAD}" y="${y + 14}" text-anchor="end" font-size="12.5" fill="#64748b">${esc(fit(footer, W - 2 * PAD, 12.5))}</text>`);
    y += 24;
  }
  const H = Math.ceil(y + PAD);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Vazirmatn">`
    + `<rect width="100%" height="100%" fill="#ffffff"/>${parts.join('')}</svg>`;
}

/** PNG جاهز للإرسال. يرمي إن تعذّر الرسم — المستدعي يتعامل (الصورة تحسين لا شرط). */
export async function renderOrderTablePng(rows, opts) {
  const { Resvg } = await import('@resvg/resvg-js'); // كسول: لا يُحمَّل إلا عند الحاجة
  const svg = buildOrderTableSvg(rows, opts);
  const r = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: 2 },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Vazirmatn' },
  });
  return r.render().asPng();
}
