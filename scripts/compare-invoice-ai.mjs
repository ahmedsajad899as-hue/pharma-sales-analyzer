// ════════════════════════════════════════════════════════════════════════════
// مقارنة قراءة الفواتير: Claude (المستخدم في الموقع) مقابل Qwen-VL
// تشغيل:  node scripts/compare-invoice-ai.mjs [مجلد الصور]
//         (الافتراضي: invoice-samples/ — مستثنى من git لأنه بيانات زبائن)
//
// يحتاج في .env المحلي:  ANTHROPIC_API_KEY=...   DASHSCOPE_API_KEY=...
// اختياري:  QWEN_MODEL (افتراضي qwen3-vl-plus)
//           QWEN_BASE_URL (افتراضي الدولي؛ مفتاح حساب الصين: https://dashscope.aliyuncs.com/compatible-mode/v1)
//           QWEN_PRICE_IN / QWEN_PRICE_OUT  — دولار لكل مليون توكن، من صفحة أسعار حسابك
//
// نفس برومبت الموقع (INVOICE_PROMPT) ونفس المحلّل (parseInvoiceJson) لكلا النموذجين،
// بلا خطوة تدوير الصورة وبلا تسجيل في جدول الاستهلاك — لا يلمس قاعدة البيانات.
// ════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { INVOICE_PROMPT, parseInvoiceJson } from '../server/modules/sales/sales.service.js';
import { AI_MODEL } from '../server/lib/claudeAi.js';

const DIR = path.resolve(process.argv[2] || 'invoice-samples');
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3-vl-plus';
const QWEN_BASE_URL = (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
const CLAUDE_PRICE = { in: 2, out: 10 }; // Sonnet 5.5
const QWEN_PRICE = process.env.QWEN_PRICE_IN && process.env.QWEN_PRICE_OUT
  ? { in: Number(process.env.QWEN_PRICE_IN), out: Number(process.env.QWEN_PRICE_OUT) }
  : null;
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

for (const k of ['ANTHROPIC_API_KEY', 'DASHSCOPE_API_KEY']) {
  if (!process.env[k]) { console.error(`✗ ${k} غير موجود في .env المحلي`); process.exit(1); }
}

let files;
try {
  files = readdirSync(DIR).filter(f => MIME[path.extname(f).toLowerCase()]).sort();
} catch {
  console.error(`✗ المجلد غير موجود: ${DIR}`); process.exit(1);
}
if (!files.length) { console.error(`✗ لا صور (jpg/png/webp) في ${DIR}`); process.exit(1); }

const anthropic = new Anthropic();

async function readWithClaude(mime, b64) {
  const msg = await anthropic.beta.messages.create({
    model: AI_MODEL,
    max_tokens: 16_000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'between_tools' }, // نفس thinkingBudget: 0 في الموقع
    messages: [{ role: 'user', content: [
      { type: 'text', text: INVOICE_PROMPT },
      { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
    ] }],
  }, { timeout: 90_000 });
  const u = msg.usage || {};
  return {
    text: msg.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    outTok: u.output_tokens || 0,
  };
}

async function readWithQwen(mime, b64) {
  const res = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        { type: 'text', text: INVOICE_PROMPT },
      ] }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`);
  return {
    text: body.choices?.[0]?.message?.content || '',
    inTok: body.usage?.prompt_tokens || 0,
    outTok: body.usage?.completion_tokens || 0,
  };
}

async function timed(fn) {
  const t = Date.now();
  try { return { ...(await fn()), ms: Date.now() - t }; }
  catch (err) { return { error: String(err?.message || err).slice(0, 300), ms: Date.now() - t }; }
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\-_.,/\\()«»"']+/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
const num = (v) => (v == null || v === '' ? null : Number(String(v).replace(/[^\d.]/g, '')) || 0);
const cost = (r, p) => (p ? (r.inTok * p.in + r.outTok * p.out) / 1e6 : null);
const usd = (v) => (v == null ? '—' : `$${v.toFixed(4)}`);

function compareRows(cRows, qRows) {
  const lines = [];
  let agree = 0;
  const used = new Set();
  for (const c of cRows) {
    const key = norm(c.item);
    let qi = qRows.findIndex((q, i) => !used.has(i) && norm(q.item) === key);
    if (qi < 0) qi = qRows.findIndex((q, i) => !used.has(i) && key && (norm(q.item).includes(key) || key.includes(norm(q.item))));
    if (qi < 0) { lines.push(`   ✗ Qwen ما قرأ: «${c.item}» (كمية ${c.quantity})`); continue; }
    used.add(qi);
    const q = qRows[qi];
    const diffs = ['quantity', 'bonus', 'unitPrice', 'total']
      .filter(f => num(c[f]) !== num(q[f]))
      .map(f => `${f}: Claude=${c[f] ?? '-'} / Qwen=${q[f] ?? '-'}`);
    const nameDiff = norm(c.item) !== norm(q.item) ? `  [الاسم: Qwen=«${q.item}»]` : '';
    if (!diffs.length && !nameDiff) { agree++; lines.push(`   ✓ ${c.item}`); }
    else lines.push(`   ≠ ${c.item}${nameDiff}${diffs.length ? '  ' + diffs.join('، ') : ''}`);
  }
  qRows.forEach((q, i) => { if (!used.has(i)) lines.push(`   + Qwen فقط: «${q.item}» (كمية ${q.quantity})`); });
  return { lines, agree };
}

function header(rows) {
  const r = rows.find(x => x.pharmacy || x.warehouse) || rows[0] || {};
  return { warehouse: r.warehouse, invoiceNumber: r.invoiceNumber, date: r.date, pharmacy: r.pharmacy, area: r.area };
}

console.log(`مقارنة ${files.length} صورة — Claude (${AI_MODEL}) مقابل Qwen (${QWEN_MODEL})\n`);
const totals = { claude: { inTok: 0, outTok: 0, ms: 0, rows: 0, fail: 0 }, qwen: { inTok: 0, outTok: 0, ms: 0, rows: 0, fail: 0 }, agree: 0 };
const raw = [];

for (const f of files) {
  const full = path.join(DIR, f);
  const mime = MIME[path.extname(f).toLowerCase()];
  const sizeMb = statSync(full).size / 1024 / 1024;
  const b64 = readFileSync(full).toString('base64');
  console.log(`━━━ ${f}  (${sizeMb.toFixed(1)}MB)${sizeMb > 5 ? '  ⚠ أكبر من 5MB — Claude قد يرفضها' : ''}`);

  const [c, q] = await Promise.all([timed(() => readWithClaude(mime, b64)), timed(() => readWithQwen(mime, b64))]);
  const cRows = c.error ? [] : parseInvoiceJson(c.text);
  const qRows = q.error ? [] : parseInvoiceJson(q.text);
  raw.push({ file: f, claude: c.text ?? c.error, qwen: q.text ?? q.error });

  for (const [name, r, rows] of [['Claude', c, cRows], ['Qwen  ', q, qRows]]) {
    const t = totals[name.trim().toLowerCase()];
    t.ms += r.ms;
    if (r.error) { t.fail++; console.log(`   ${name}: ✗ خطأ — ${r.error}`); continue; }
    t.inTok += r.inTok; t.outTok += r.outTok; t.rows += rows.length;
    if (!rows.length) t.fail++;
    console.log(`   ${name}: ${rows.length} سطر، ${(r.ms / 1000).toFixed(1)}s، ${r.inTok}+${r.outTok} توكن${rows.length ? '' : '  ✗ JSON غير صالح'}`);
  }

  const hc = header(cRows), hq = header(qRows);
  for (const k of Object.keys(hc)) {
    if (norm(hc[k]) !== norm(hq[k])) console.log(`   ترويسة ${k}: Claude=«${hc[k] ?? '-'}» / Qwen=«${hq[k] ?? '-'}»`);
  }
  if (cRows.length || qRows.length) {
    const { lines, agree } = compareRows(cRows, qRows);
    totals.agree += agree;
    console.log(lines.join('\n'));
  }
  console.log();
}

const cc = cost(totals.claude, CLAUDE_PRICE), qc = cost(totals.qwen, QWEN_PRICE);
console.log('═══ الخلاصة');
console.log(`   Claude: ${totals.claude.rows} سطر، فشل ${totals.claude.fail}، متوسط ${(totals.claude.ms / files.length / 1000).toFixed(1)}s، كلفة ${usd(cc)} (${usd(cc && cc / files.length)}/فاتورة)`);
console.log(`   Qwen  : ${totals.qwen.rows} سطر، فشل ${totals.qwen.fail}، متوسط ${(totals.qwen.ms / files.length / 1000).toFixed(1)}s، كلفة ${QWEN_PRICE ? `${usd(qc)} (${usd(qc / files.length)}/فاتورة)` : `— (${totals.qwen.inTok}+${totals.qwen.outTok} توكن؛ ضع QWEN_PRICE_IN/OUT لحسابها)`}`);
console.log(`   أسطر متطابقة تماماً: ${totals.agree} من ${totals.claude.rows} (مرجع المقارنة قراءة Claude — ليست بالضرورة الصحيحة؛ راجع ≠ على الصورة)`);

const out = path.join(DIR, 'compare-results.json');
writeFileSync(out, JSON.stringify(raw, null, 2));
console.log(`\n   الردود الخام: ${out}`);
