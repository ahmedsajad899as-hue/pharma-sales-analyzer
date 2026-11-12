// ════════════════════════════════════════════════════════════════════════════
// invoiceCardAuto.js — بطاقات المذاخر **تلقائياً** من صور كروباتها.
// ────────────────────────────────────────────────────────────────────────────
// طلب صاحب المشروع (2026-11-13): كل صورة فاتورة تصل كروب مذخر مربوط (أو رقمه) تُحفظ في مجلد
// ذلك المذخر، ويُبقى أفضل 10 بالجودة، ومنها تُكتب بطاقته (وصف نموذج فواتيره) بلا تدخّل.
// البطاقة تجعل القراءة أرخص (برومبت مختصر ~1,850 بدل ~3,650 token) وأدق، وتُلغي تصويت سطر
// الزبون (3 نداءات) — وهو أكبر بند في كلفة صور كروب «سبأ» قبلها.
//
// الدورة: عيّنات ≥ 5 ⇒ توليد (نداء واحد بالأقوى يرى الصور + مثالَي البطاقتين الجاهزتين) ⇒
// تحقّق: قراءة 3 عيّنات بالبطاقة الجديدة، ويُفعَّل إن اجتاز ثلثاها فحص الأرقام والصيدلية، وإلا
// تُحفظ مسودة معطّلة وتُعاد المحاولة حين تزيد العيّنات. عند بلوغ 10 تُعاد كتابتها من العشر.
// البطاقات اليدوية (source=manual) لا تُمسّ أبداً. كلفة التوليد ~0.01$ مرة لكل مذخر.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import jpeg from 'jpeg-js';
import prisma from './prisma.js';
import { callAI, aiCallScope } from './geminiAi.js';
import { AI_MODELS, diagnoseInvoiceRows } from './aiModelSettings.js';
import { DEFAULT_CARDS, CARD_BASE_PROMPT, parseCardReply, invalidateInvoiceCards, matchCard } from './invoiceCards.js';
import { downscaleJpeg, isJpeg, rotateJpeg } from './invoiceImage.js';
import { isPdf } from './invoicePdf.js';
import { detectOrientationLocal } from './invoiceOrientation.js';
import { pharmacyKey } from './pharmacyKey.js';
import { INVOICE_READ_DIR } from './invoiceReadLog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CARD_SAMPLES_DIR = path.join(__dirname, '..', '..', 'uploads', 'invoice-card-samples');
const KEEP = 10;          // أفضل 10 لكل مذخر
const FIRST_AT = 5;       // أول توليد عند 5 عيّنات
const MAX_ATTEMPTS = 4;   // مسودة فشلت: محاولات أخرى كلما زادت العيّنات 3
const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_SAMPLE_BYTES = 6 * 1024 * 1024;

/** مفتاح اسم المذخر (مجلد العيّنات ومطابقة البطاقة): حروف موحّدة بلا فواصل ولا «مذخر/أدوية». */
export function warehouseKey(name) {
  return String(name ?? '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/مذخر|مذاخر|ادويه|ادوية|للادويه|للادوية|شركه|شركة/g, ' ')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const num = (v) => { const x = Number(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(x) ? x : 0; };

/** حدّة الصورة: تباين لابلاس على نسخة رمادية مصغّرة (صورة مهزوزة/ضبابية ⇒ قيمة صغيرة). */
function sharpness(buf) {
  try {
    const { width: w, height: h, data } = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 256 });
    const s = Math.min(1, 800 / Math.max(w, h));
    const nw = Math.max(3, Math.round(w * s)), nh = Math.max(3, Math.round(h * s));
    const g = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const i = (Math.min(h - 1, Math.floor(y / s)) * w + Math.min(w - 1, Math.floor(x / s))) * 4;
        g[y * nw + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
    }
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < nh - 1; y++) {
      for (let x = 1; x < nw - 1; x++) {
        const v = 4 * g[y * nw + x] - g[y * nw + x - 1] - g[y * nw + x + 1] - g[(y - 1) * nw + x] - g[(y + 1) * nw + x];
        sum += v; sum2 += v * v; n++;
      }
    }
    const mean = sum / n;
    return { w, h, lap: sum2 / n - mean * mean };
  } catch { return { w: 0, h: 0, lap: 0 }; }
}

/**
 * درجة جودة العيّنة — الأعلى أنفع لكتابة البطاقة: قراءة اتّسقت أرقامها ووجدت الزبون، أصناف
 * أكثر (تُظهر الجدول)، صورة حادّة وكبيرة وواضحة الاتجاه. PDF نصّه كامل الوضوح.
 */
function sampleScore({ kind, rows, numbersOk, hasPharmacy, meta }) {
  let score = (numbersOk ? 2 : 0) + (hasPharmacy ? 1 : 0) + Math.min(rows, 8) / 8;
  if (kind === 'pdf') return score + 2;
  score += Math.min(1, Math.min(meta.w, meta.h) / 1000);
  score += Math.min(1, meta.lap / 400);
  if (meta.orientSure) score += 0.5;
  return Math.round(score * 1000) / 1000;
}

/**
 * يحفظ صورة فاتورة من كروب/رقم مذخر كعيّنة لبطاقته إن كانت ضمن أفضل 10، ثم قد يولّد البطاقة.
 * لا ترمي ولا تُنتظر (fire-and-forget بعد القراءة).
 * @param {{ warehouse:string, buffer:Buffer, rows?:object[], source?:string, generate?:boolean }} p
 */
export async function collectCardSample({ warehouse, buffer, rows = [], source = null, generate = true }) {
  try {
    const name = String(warehouse || '').trim();
    const whKey = warehouseKey(name);
    if (!whKey || !Buffer.isBuffer(buffer) || buffer.length > MAX_SAMPLE_BYTES) return;
    const kind = isPdf(buffer) ? 'pdf' : isJpeg(buffer) ? 'photo' : null;
    if (!kind) return;
    const items = rows.filter(r => r?.item);
    const hasPharmacy = rows.some(r => String(r?.pharmacy ?? '').trim());
    if (!items.length && !hasPharmacy) return; // ليست فاتورة مقروءة — لا تصلح عيّنة
    const grandTotal = rows.find(r => r?.grandTotal != null)?.grandTotal ?? null;
    const numbersOk = items.length > 0 && items.some(r => num(r.total) > 0)
      && diagnoseInvoiceRows(items, { grandTotal, needPharmacy: false }).ok;
    const hash = crypto.createHash('sha1').update(buffer).digest('hex');
    if (await prisma.invoiceCardSample.findUnique({ where: { whKey_hash: { whKey, hash } } })) return;
    let meta = { w: 0, h: 0, lap: 0, orientSure: false };
    if (kind === 'photo') {
      meta = { ...sharpness(buffer), orientSure: Boolean(detectOrientationLocal(buffer).sure) };
      if (Math.min(meta.w, meta.h) < 400) return; // صغيرة جداً
    }
    const score = sampleScore({ kind, rows: items.length, numbersOk, hasPharmacy, meta });

    const kept = await prisma.invoiceCardSample.findMany({ where: { whKey }, orderBy: { score: 'asc' }, select: { id: true, score: true, file: true } });
    if (kept.length >= KEEP && score <= kept[0].score) return; // ليست ضمن الأفضل

    const dir = path.join(CARD_SAMPLES_DIR, whKey);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = `${hash}.${kind === 'pdf' ? 'pdf' : 'jpg'}`;
    let data = buffer;
    if (kind === 'photo') { try { data = downscaleJpeg(buffer, 1600); } catch { data = buffer; } }
    await fs.promises.writeFile(path.join(dir, file), data);
    await prisma.invoiceCardSample.create({
      data: { warehouse: name, whKey, file, kind, hash, score, rowCount: items.length, numbersOk, hasPharmacy, source },
    });
    // أكثر من 10 ⇒ يُحذف الأضعف (ملفاً وصفاً) — القرص ضيّق
    const all = await prisma.invoiceCardSample.findMany({ where: { whKey }, orderBy: [{ score: 'desc' }, { id: 'desc' }], select: { id: true, file: true } });
    for (const old of all.slice(KEEP)) {
      await prisma.invoiceCardSample.delete({ where: { id: old.id } }).catch(() => {});
      fs.promises.unlink(path.join(dir, path.basename(old.file))).catch(() => {});
    }
    if (generate) maybeGenerateCard(name).catch(e => console.error('[invoice-cards-auto] توليد:', e?.message));
  } catch (e) {
    console.error('[invoice-cards-auto] حفظ عيّنة:', String(e?.message || e).slice(0, 160));
  }
}

// ─── توليد البطاقة ───────────────────────────────────────────────────────────

const busy = new Set();

function genPrompt(name, n, examples) {
  return `أنت تكتب «بطاقة» لنموذج فواتير مذخر أدوية عراقي اسمه «${name}»: وصفٌ ثابت لتصميم فواتيره يُلحَق ببرومبت قراءة مختصر، كي يقرأ نموذجُ ذكاءٍ أرخص فواتيرَ هذا المذخر بدقة.
الملفات المرفقة (${n}) فواتير حقيقية من هذا المذخر نفسه.

${examples.length > 1 ? 'هذه أمثلة لبطاقات جاهزة' : 'هذا مثال لبطاقة جاهزة'} لمذخر${examples.length > 1 ? 'ين' : ''} آخر${examples.length > 1 ? 'ين' : ''} — للأسلوب والمستوى فقط، لا تنسخ محتواها:
${examples.map((c, i) => `--- مثال ${i + 1} ---\n${c.prompt}`).join('\n')}
---

اكتب بطاقة هذا المذخر بنفس الأسلوب، أسطراً قصيرة تبدأ بـ «-»، تصف:
- warehouse = «${name}»، وكيف يُطبع اسمه/شعاره في الفاتورة.
- مكان الزبون (الصيدلية المشترية) وعنوان حقله بالضبط («المتعامل» أو «اسم العميل» أو «السيد»…) وشكل السطر (الاسم ثم المنطقة؟ الفاصل؟)، وما يُهمل بجانبه (مندوب، هاتف…).
- مكان رقم الفاتورة وتاريخها وصيغة التاريخ.
- أعمدة جدول الأصناف بالترتيب من اليمين، وأيّها الكمية وسعر الوحدة ومجموع السطر.
- كيف يظهر البونص: عمود مستقل (bonusStyle = column)، أو سطر مكرّر للمادة بلا مبلغ (bonusStyle = row، وقل للموديل أن يعيده صفاً مستقلاً priceShown = false)، أو «10+2» داخل الكمية (row).
- فاصل الآلاف في المبالغ، وما تحت الجدول من مجاميع ليست أصنافاً.
قواعد صارمة:
- **ممنوع** أن تكتب أي اسم صيدلية أو شخص أو رقم فاتورة أو مبلغ من هذه الفواتير — استعمل رموزاً مثل ‹اسم› و‹منطقة›.
- صف فقط ما هو ثابت في كل فواتير هذا المذخر.
أعِد **كائن JSON فقط**: {"bonusStyle":"row أو column","prompt":"نص البطاقة"}`;
}

const readSample = async (s) => {
  const buf = await fs.promises.readFile(path.join(CARD_SAMPLES_DIR, s.whKey, path.basename(s.file)));
  if (s.kind === 'pdf') return { mimeType: 'application/pdf', buf };
  // الاتجاه محلياً إن تأكّد — الموديل يرى العيّنات قائمة
  const o = detectOrientationLocal(buf);
  return { mimeType: 'image/jpeg', buf: o.sure && o.deg ? rotateJpeg(buf, o.deg) : buf };
};

/**
 * كتابة البطاقة والتحقّق منها (نداءات الذكاء فقط — بلا قاعدة بيانات، فتُختبر وحدها).
 * @param {string} name اسم المذخر
 * @param {{ mimeType:string, buf:Buffer }[]} files العيّنات (الأفضل أولاً)
 * @param {{ knownNames?:string[], examples?:object[] }} [opts] knownNames = أسماء صيدليات شوهدت في
 *        فواتيره — تُمحى من نص البطاقة. examples = بطاقات أمثلة (الافتراضي: البطاقتان اليدويتان،
 *        عدا بطاقة المذخر نفسه إن وُجدت — وإلا نسخها الموديل بدل أن يقرأ الصور).
 * @returns {Promise<{ prompt:string, bonusStyle:'row'|'column', ok:number, of:number }>} يرمي إن لم تُكتب بطاقة
 */
export async function generateCardFromFiles(name, files, { knownNames = [], examples = null } = {}) {
  const own = warehouseKey(name);
  const ex = (examples || DEFAULT_CARDS).filter(c => { const k = warehouseKey(c.name); return !(k && own && (k.includes(own) || own.includes(k))); });
  const parts = [genPrompt(name, files.length, ex.length ? ex : DEFAULT_CARDS.slice(0, 1))];
  files.forEach((f, i) => {
    parts.push(`الفاتورة ${i + 1}:`);
    parts.push({ inlineData: { mimeType: f.mimeType, data: f.buf.toString('base64') } });
  });
  const reply = String(await callAI(parts, { timeoutMs: 120_000, thinkingBudget: 0, feature: 'invoice-card-gen', model: AI_MODELS.strong }));
  const m = reply.replace(/```json\s*/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/);
  const o = m ? JSON.parse(m[0]) : null;
  let prompt = String(o?.prompt ?? '').trim();
  if (prompt.length < 80) throw new Error('بطاقة فارغة أو قصيرة');
  const bonusStyle = /column/i.test(String(o?.bonusStyle)) ? 'column' : 'row';
  // حارس: اسم صيدلية حقيقي في نص البطاقة يجعل isCopiedFromPrompt يُفرغ تلك الصيدلية من كل
  // قراءة لاحقة (حدث 2026-11-10 فشغّل 3 نداءات احتياطية) — يُستبدل برمز.
  const names = [...new Set(knownNames.map(p => String(p ?? '').trim()).filter(p => pharmacyKey(p).length >= 4))];
  for (const p of names) prompt = prompt.split(p).join('‹اسم›');

  // تحقّق: قراءة حتى 3 عيّنات بالبطاقة الجديدة (البرومبت المختصر نفسه الذي ستُقرأ به الفواتير)
  const check = files.slice(0, 3);
  let ok = 0;
  for (const f of check) {
    try {
      const text = await callAI([`${CARD_BASE_PROMPT}${prompt}`, { inlineData: { mimeType: f.mimeType, data: f.buf.toString('base64') } }],
        { timeoutMs: 70_000, thinkingBudget: 0, feature: 'invoice-card-check', model: AI_MODELS.strong });
      const rows = parseCardReply(text, () => []);
      const d = diagnoseInvoiceRows(rows, { grandTotal: rows.find(r => r.grandTotal != null)?.grandTotal, needPharmacy: true });
      if (d.ok) ok++;
    } catch { /* يُحسب فاشلاً */ }
  }
  return { prompt, bonusStyle, ok, of: check.length };
}

/**
 * يولّد/يحدّث بطاقة مذخر من أفضل عيّناته إن حان وقتها. لا ترمي.
 * @param {string} name اسم المذخر كما في ربط الكروب
 * @param {{ force?:boolean }} [opts] force = من لوحة الماستر («إعادة توليد») بلا شروط العدد/المهلة
 */
export async function maybeGenerateCard(name, { force = false } = {}) {
  const whKey = warehouseKey(name);
  if (!whKey || busy.has(whKey) || busy.size >= 2) return null;
  busy.add(whKey);
  try {
    const samples = await prisma.invoiceCardSample.findMany({ where: { whKey }, orderBy: [{ score: 'desc' }, { id: 'desc' }] });
    if (samples.length < (force ? 3 : FIRST_AT)) return null;
    const allCards = await prisma.warehouseInvoiceCard.findMany({ orderBy: { id: 'asc' } });
    // نفس الاسم، أو بطاقة يطابقها اسم الكروب («طريق السلام / الحارثية» ← «طريق السلام») —
    // القراءة تختار تلك البطاقة أصلاً، فلا تُولَّد ثانية بجانبها
    const existing = allCards.find(c => c.name === String(name).trim()) || matchCard(allCards, name);
    if (existing && existing.source !== 'auto') return null; // يدوية: لا تُمسّ
    if (!force && existing) {
      const recent = existing.lastGenAt && Date.now() - new Date(existing.lastGenAt).getTime() < COOLDOWN_MS;
      if (recent) return null;
      const grownTo10 = existing.enabled && existing.sampleCount < KEEP && samples.length >= KEEP;
      const draftRetry = !existing.enabled && existing.genAttempts < MAX_ATTEMPTS && samples.length >= existing.sampleCount + 3;
      if (!grownTo10 && !draftRetry) return null;
    }

    const files = await Promise.all(samples.slice(0, KEEP).map(readSample));
    const knownNames = (await prisma.invoiceReadLog.findMany({
      where: { chatTitle: String(name).trim(), pharmacy: { not: null } }, select: { pharmacy: true }, take: 200, orderBy: { id: 'desc' },
    })).map(r => r.pharmacy);
    const calls = [];
    const result = await aiCallScope.run(calls, () => generateCardFromFiles(String(name).trim(), files, { knownNames }));

    const pass = result.ok >= Math.ceil(result.of * 2 / 3);
    const keepOld = existing?.enabled && !pass; // بطاقة مفعّلة سابقة أفضل من إعادة كتابة فاشلة
    const data = {
      source: 'auto', sampleCount: samples.length, checkedOk: result.ok, checkedOf: result.of,
      genAttempts: (existing?.genAttempts || 0) + 1, lastGenAt: new Date(),
      note: pass ? null : `لم تجتز التحقق (${result.ok}/${result.of}) — مسودة`,
      ...(keepOld ? {} : { prompt: result.prompt, bonusStyle: result.bonusStyle, enabled: pass }),
    };
    const card = existing
      ? await prisma.warehouseInvoiceCard.update({ where: { id: existing.id }, data })
      : await prisma.warehouseInvoiceCard.create({ data: { name: String(name).trim(), ...data, prompt: result.prompt, bonusStyle: result.bonusStyle, enabled: pass } });
    invalidateInvoiceCards();
    const cost = calls.reduce((a, c) => a + (c.promptTokens || 0) * 0.75e-6 + (c.outputTokens || 0) * 3.75e-6, 0);
    console.log(`[invoice-cards-auto] بطاقة «${name}» من ${samples.length} صورة: تحقّق ${result.ok}/${result.of} ⇒ ${pass ? 'مفعّلة' : keepOld ? 'أُبقيت السابقة' : 'مسودة'} (~$${cost.toFixed(4)})`);
    return card;
  } catch (e) {
    console.error(`[invoice-cards-auto] توليد بطاقة «${name}»:`, String(e?.message || e).slice(0, 200));
    try {
      const ex = await prisma.warehouseInvoiceCard.findFirst({ where: { name: String(name).trim(), source: 'auto' } });
      if (ex) await prisma.warehouseInvoiceCard.update({ where: { id: ex.id }, data: { genAttempts: { increment: 1 }, lastGenAt: new Date() } });
    } catch { /* لا شيء */ }
    return null;
  } finally {
    busy.delete(whKey);
  }
}

// ─── تعبئة أولى من السجلّ ────────────────────────────────────────────────────

/**
 * عند الإقلاع: صور كروبات المذاخر المقروءة سابقاً (سجلّ «الطلبيات المحلَّلة»، آخر 60 يوماً)
 * تُضاف عيّنات لمذاخرها — كي لا تنتظر بطاقة «سبأ» وصول 5 صور جديدة. لا ترمي.
 */
export async function backfillCardSamples() {
  try {
    const linked = await prisma.orderWarehouse.findMany({
      where: { OR: [{ channel: 'group', groupJid: { not: null } }, { waId: { not: null } }] }, select: { name: true },
    });
    const names = [...new Set(linked.map(w => String(w.name || '').trim()).filter(Boolean))];
    for (const name of names) {
      const whKey = warehouseKey(name);
      // مرة واحدة لكل مذخر: من لديه عيّنات أصلاً تكفيه الصور الجديدة
      if (!whKey || await prisma.invoiceCardSample.count({ where: { whKey } }) > 0) continue;
      const logs = await prisma.invoiceReadLog.findMany({
        where: { source: { in: ['warehouse-group', 'warehouse-cloud'] }, chatTitle: name, imageFile: { not: null } },
        orderBy: { id: 'desc' }, take: 40,
      });
      let added = 0;
      for (const log of logs) {
        const p = path.join(INVOICE_READ_DIR, path.basename(log.imageFile));
        if (!fs.existsSync(p)) continue;
        const items = Array.isArray(log.details?.items) ? log.details.items : [];
        const rows = items.map(([item, quantity, bonus, unitPrice, total]) => ({ item, quantity, bonus, unitPrice, total, pharmacy: log.pharmacy }));
        if (!rows.length && log.pharmacy) rows.push({ pharmacy: log.pharmacy });
        await collectCardSample({ warehouse: name, buffer: await fs.promises.readFile(p), rows, source: 'backfill', generate: false });
        added++;
      }
      if (added) {
        console.log(`[invoice-cards-auto] تعبئة أولى: ${added} صورة سابقة لـ«${name}»`);
        await maybeGenerateCard(name);
      }
    }
  } catch (e) {
    console.error('[invoice-cards-auto] تعبئة أولى:', String(e?.message || e).slice(0, 160));
  }
}

// ─── لوحة الماستر ────────────────────────────────────────────────────────────

export async function listCardsWithSamples() {
  const [cards, counts] = await Promise.all([
    prisma.warehouseInvoiceCard.findMany({ orderBy: { id: 'asc' } }),
    prisma.invoiceCardSample.groupBy({ by: ['whKey', 'warehouse'], _count: { _all: true } }),
  ]);
  const byKey = new Map(counts.map(c => [c.whKey, c._count._all]));
  const out = cards.map(c => ({ ...c, samples: byKey.get(warehouseKey(c.name)) || 0 }));
  // مذاخر لها عيّنات ولا بطاقة بعد
  for (const c of counts) {
    if (!cards.some(k => warehouseKey(k.name) === c.whKey)) {
      out.push({ id: null, name: c.warehouse, source: 'auto', enabled: false, prompt: null, samples: c._count._all, pending: true });
    }
  }
  return out;
}
