// ════════════════════════════════════════════════════════════════════════════
// invoicePdf.js — فاتورة PDF من نظام المذخر: نصّها يُستخرج **محلياً بلا ذكاء**.
// ────────────────────────────────────────────────────────────────────────────
// PDF المولَّد من برنامج المذخر يحمل النص نفسه (لا صورة)، فلا حاجة لقراءة بصرية ولا
// اتجاه ولا تكبير: نستخرج الأسطر بمواضعها (pdf.js المضمَّن في pdf-parse)، ونعيد بناء
// كل سطر بترتيب القراءة (يمين←يسار للعربية) والخانات مفصولة بـ « | ». ثم يكفي نداء
// نصّي رخيص لترتيبها صفوفاً (sales.service: readPdfInvoice).
// PDF ممسوح ضوئياً (بلا نص) ⇒ hasText=false فيُرسل الملف نفسه للذكاء كصورة.
// ════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
// المسار الداخلي عمداً: index.js في pdf-parse 1.1.1 يقرأ ملف اختبار غير موجود حين
// لا يجد module.parent (استيراد ESM) فيرمي ENOENT.
let pdfParse = null;
const loadPdfParse = () => (pdfParse ||= _require('pdf-parse/lib/pdf-parse.js'));

const MAX_PAGES = 4;
const MAX_CHARS = 12_000; // سقف ما يُرسل للنداء النصي (~فاتورتان كبيرتان)

/** هل البايتات ملف PDF؟ (بعض المولّدات تسبق الترويسة ببايتات قليلة) */
export function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 1024).includes('%PDF-');
}

const AR = /[؀-ۿﭐ-﷿ﹰ-﻿]/g;
const LATIN = /[A-Za-z]/g;
const count = (s, re) => (String(s).match(re) || []).length;

// أشكال فارسية/أردية يكتبها بعض مولّدي PDF (كروم مثلاً) بدل العربية: «ی/ھ/ک» ← «ي/ه/ك».
const fixLetters = (s) => s.normalize('NFKC').replace(/[یې]/g, 'ي').replace(/[ھہە]/g, 'ه').replace(/ک/g, 'ك');

/**
 * صفحة ← أسطر: تجميع العناصر بالارتفاع، ثم ترتيبها أفقياً **باتجاه واحد للصفحة كلها**.
 * اتجاه لكل سطر كان يقلب أسطر الأصناف اللاتينية وحدها (المبلغ أولاً) بينما رأس الجدول
 * العربي من اليمين — فتختلط الكمية بالبونص. باتجاه واحد تبقى الأعمدة متطابقة مع رأسها.
 */
async function renderPage(pageData) {
  const tc = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
  const items = (tc.items || [])
    .filter(it => String(it.str || '').trim())
    .map(it => ({
      str: fixLetters(String(it.str)).replace(/\s+/g, ' ').trim(),
      x: it.transform[4], y: it.transform[5],
      w: Number(it.width) || 0,
      h: Math.abs(it.transform[3]) || Number(it.height) || 8,
    }));
  if (!items.length) return '';
  const hs = items.map(i => i.h).sort((a, b) => a - b);
  const fh = hs[Math.floor(hs.length / 2)] || 8;
  const tol = Math.max(1.5, fh * 0.45);
  const all = items.map(i => i.str).join(' ');
  const ar = count(all, AR), lat = count(all, LATIN);
  const rtl = ar >= 40 || ar >= (ar + lat) * 0.25;
  items.sort((a, b) => b.y - a.y); // pdf: y للأعلى ⇒ من رأس الصفحة لأسفلها
  const lines = [];
  for (const it of items) {
    const line = lines.find(l => Math.abs(l.y - it.y) <= tol);
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map(({ items: its }) => {
    // 1) خانات: العناصر بترتيب x، وفجوة كبيرة تبدأ خانة جديدة. داخل الخانة تُقرأ القطع
    //    باتجاه الخانة نفسها — اسم صنف لاتيني يقسمه pdf.js قطعاً («500MG T» + «AB»)
    //    كان يُقلب مع اتجاه الصفحة فيصير «ABPANADOL…».
    its.sort((a, b) => a.x - b.x);
    const cells = [];
    let cur = null;
    for (const it of its) {
      const gap = cur ? it.x - (cur.end) : Infinity;
      if (!cur || gap > fh * 1.1) { cur = { parts: [], end: 0, x: it.x }; cells.push(cur); }
      // فجوة ضئيلة = نفس الكلمة مقسومة (تقطيع الحروف)، متوسطة = مسافة
      cur.parts.push({ s: it.str, sep: cur.parts.length ? (gap > fh * 0.2 ? ' ' : '') : '' });
      cur.end = Math.max(cur.end, it.x + it.w);
    }
    const cellText = (c) => {
      const t = c.parts.map(p => p.s).join(' ');
      const cellRtl = count(t, AR) > count(t, LATIN);
      const parts = cellRtl ? [...c.parts].reverse() : c.parts;
      // الفاصل ينتمي للفجوة بين قطعتين — مع القلب يُؤخذ من القطعة التالية بالترتيب الأصلي
      return parts.map((p, i) => (i ? (cellRtl ? c.parts[c.parts.length - i].sep : p.sep) : '') + p.s).join('');
    };
    // 2) الخانات بترتيب الصفحة الواحد (يمين←يسار للعربية) فتطابق رأس الجدول
    const ordered = rtl ? [...cells].reverse() : cells;
    return ordered.map(cellText).join(' | ');
  }).join('\n');
}

/**
 * @param {Buffer} buf
 * @returns {Promise<{ text:string, pages:number, hasText:boolean }>} لا ترمي — فشل القراءة = hasText:false.
 */
export async function extractPdfText(buf) {
  try {
    const parse = loadPdfParse();
    const r = await parse(buf, { pagerender: renderPage, max: MAX_PAGES });
    const text = String(r.text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHARS);
    // نصّ حقيقي: أحرف كافية وأرقام (الفاتورة بلا أرقام ليست فاتورة)
    const letters = count(text, AR) + count(text, LATIN);
    const hasText = letters >= 40 && /\d/.test(text);
    return { text, pages: Number(r.numpages) || 0, hasText };
  } catch (e) {
    console.error('[invoice-pdf] تعذّر استخراج النص:', String(e?.message || e).slice(0, 160));
    return { text: '', pages: 0, hasText: false };
  }
}
