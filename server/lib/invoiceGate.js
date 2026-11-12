// ════════════════════════════════════════════════════════════════════════════
// invoiceGate.js — فحص سريع رخيص قبل قراءة فاتورة كروب المذخر كاملة.
// ────────────────────────────────────────────────────────────────────────────
// كروب المذخر يُنشر فيه فواتير كل زبائن المذخر، لا فواتيرنا فقط. مقيس 2026-11-12: كل
// الصور العشر التي قُرئت كاملة من كروب «سبأ» (5 نداءات ≈ 0.01$ لكلٍّ) لم تطابق أي طلبية
// مفتوحة (أعلى درجة 37 والحد 60) فرُميت. الفحص يقرأ اسم الزبون والأصناف فقط (نداء واحد
// بالأرخص، إخراج ~30 token) ويقارنها بالطلبيات المفتوحة — ولا قراءة كاملة إلا لما قد يخصّنا.
//
// الحساب «متفائل» عمداً: المذخر والتاريخ يُحسبان كاملين لصالح الطلبية، وما لم يُقرأ (اسم أو
// أصناف) يُحسب مطابقاً — فلا تُرفض فاتورة كان المسار الكامل سيقبلها (حدّه 60) إلا إن أخطأ
// الفحص نفسه في قراءة الاسم والأصناف معاً. الحدّ هنا 50 هامشَ أمان.
//
// PDF بنصّ: البحث عن اسم الصيدلية وأصنافها في النص مباشرة — بلا ذكاء إطلاقاً.
// ════════════════════════════════════════════════════════════════════════════

import { callAI } from './geminiAi.js';
import { getAiMode, AI_MODELS } from './aiModelSettings.js';
import { detectOrientationLocal } from './invoiceOrientation.js';
import { rotateJpeg, canRotate } from './invoiceImage.js';
import { isPdf, extractPdfText } from './invoicePdf.js';
import { pharmacyKey } from './pharmacyKey.js';
import { placeSim, nameSim } from '../modules/rep-orders/rep-orders.invoice.js';

export const GATE_MIN_SCORE = 50; // حدّ المطابقة الكاملة 60 ناقص هامش أمان
const ITEM_MATCH_MIN = 0.62;      // نفس حدّ مطابقة الأصناف في scoreOrder

const GATE_PROMPT = `صورة فاتورة مذخر أدوية (قد تكون مائلة أو مُدارة). اكتب فقط:
c = اسم الزبون (الصيدلية المشترية) كما هو مطبوع — بعد «المتعامل» أو «اسم العميل» أو «السيد» أو «الزبون»، أو سطراً في أعلى الورقة — بلا المنطقة، وليس اسم المذخر البائع ولا المندوب.
i = أسماء الأصناف (المواد) في جدول الفاتورة كما هي مطبوعة.
أعِد JSON فقط: {"c":"…","i":["…"]}
إن لم تكن الصورة فاتورة أعِد {"c":null,"i":[]}.`;

function parseObj(raw) {
  const m = String(raw ?? '').replace(/```json\s*/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const o = JSON.parse(m[0]); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

/**
 * أفضل درجة ممكنة لكل طلبية من قراءة الفحص (نفس أوزان scoreOrder: صيدلية 40، أصناف 30،
 * مذخر 15، تاريخ 15 — الأخيران كاملان دائماً هنا). المجهول يُحسب مطابقاً.
 * @param {{ pharmacy:string|null, items:string[] }} reading
 * @param {{ pharmacy:string, items:string[] }[]} candidates
 */
export function gateScore(reading, candidates) {
  const c = String(reading?.pharmacy ?? '').trim();
  const items = (reading?.items || []).map(String).filter(Boolean);
  let best = 0;
  for (const cand of candidates) {
    const ph = c ? placeSim(cand.pharmacy, c) : 1;
    let it = 1;
    if (items.length && cand.items?.length) {
      const used = new Set();
      let hits = 0;
      for (const name of cand.items) {
        const j = items.findIndex((x, k) => !used.has(k) && nameSim(name, x) >= ITEM_MATCH_MIN);
        if (j >= 0) { used.add(j); hits++; }
      }
      it = hits / Math.max(cand.items.length, items.length);
    }
    best = Math.max(best, ph * 40 + it * 30 + 30);
  }
  return Math.round(best);
}

/** نص PDF: هل يظهر فيه اسم صيدلية طلبية مفتوحة أو أصنافها؟ بلا ذكاء. */
function pdfTextScore(text, candidates) {
  const lines = String(text).split('\n').filter(Boolean);
  const cells = lines.flatMap(l => l.split(' | '));
  const whole = ` ${pharmacyKey(text)} `;
  let best = 0;
  for (const cand of candidates) {
    const k = pharmacyKey(cand.pharmacy);
    const ph = k && whole.includes(` ${k} `) ? 1 : Math.max(0, ...lines.map(l => placeSim(cand.pharmacy, l)));
    const its = cand.items || [];
    const hits = its.filter(n => cells.some(c => nameSim(n, c) >= ITEM_MATCH_MIN)).length;
    const it = its.length ? hits / its.length : 1;
    best = Math.max(best, ph * 40 + it * 30 + 30);
  }
  return Math.round(best);
}

/**
 * @param {Buffer} buf صورة JPEG أو ملف PDF
 * @param {{ pharmacy:string, items:string[] }[]} candidates الطلبيات المفتوحة لهذا المذخر
 * @returns {Promise<{ decision:'read'|'skip', pharmacy:string|null, items:string[], best:number|null, how:string }>}
 *   لا ترمي — أي فشل في الفحص نفسه ⇒ 'read' (القراءة الكاملة كما كان).
 */
export async function invoiceGate(buf, candidates) {
  if (!candidates?.length) return { decision: 'skip', pharmacy: null, items: [], best: 0, how: 'no-candidates' };
  try {
    if (isPdf(buf)) {
      const pdf = await extractPdfText(buf);
      if (!pdf.hasText) return { decision: 'read', pharmacy: null, items: [], best: null, how: 'pdf-scanned' };
      const best = pdfTextScore(pdf.text, candidates);
      return { decision: best >= GATE_MIN_SCORE ? 'read' : 'skip', pharmacy: null, items: [], best, how: 'pdf-text' };
    }
    // اتجاه محلي مجاني: الاسم يُقرأ أوضح والصورة قائمة
    let img = buf;
    const local = canRotate(buf) ? detectOrientationLocal(buf) : null;
    if (local?.sure && local.deg) {
      try { img = rotateJpeg(buf, local.deg); } catch { img = buf; }
    }
    const mode = await getAiMode('invoice-gate');
    const reply = await callAI([GATE_PROMPT, { inlineData: { mimeType: 'image/jpeg', data: img.toString('base64') } }], {
      timeoutMs: 30_000, thinkingBudget: 0, feature: 'invoice-gate',
      model: mode === 'strong' ? AI_MODELS.strong : AI_MODELS.lite,
    });
    const o = parseObj(reply);
    if (!o) return { decision: 'read', pharmacy: null, items: [], best: null, how: 'unparsed' };
    const pharmacy = String(o.c ?? '').trim() || null;
    const items = (Array.isArray(o.i) ? o.i : []).map(x => String(x ?? '').trim()).filter(Boolean).slice(0, 40);
    // ليست فاتورة (صورة منتج، لقطة محادثة…) — القراءة الكاملة كانت ستعود بلا أصناف أيضاً
    if (!pharmacy && !items.length) return { decision: 'skip', pharmacy: null, items: [], best: 0, how: 'not-invoice' };
    const best = gateScore({ pharmacy, items }, candidates);
    return { decision: best >= GATE_MIN_SCORE ? 'read' : 'skip', pharmacy, items, best, how: 'ai' };
  } catch (e) {
    console.error('[invoice-gate] فشل الفحص — قراءة كاملة كما كان:', String(e?.message || e).slice(0, 160));
    return { decision: 'read', pharmacy: null, items: [], best: null, how: 'failed' };
  }
}
