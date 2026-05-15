import prisma from '../../lib/prisma.js';
import { callGeminiSmart } from '../ai-assistant/ai-assistant.controller.js';

// ─── Helpers ────────────────────────────────────────────────
function norm(s = '') {
  return String(s).trim()
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildFileFilter(fileIds) {
  if (!fileIds) return {};
  const ids = String(fileIds).split(',').map(Number).filter(Boolean);
  if (!ids.length) return {};
  return ids.length === 1 ? { uploadedFileId: ids[0] } : { uploadedFileId: { in: ids } };
}

function toIQD(value, uploadedFile) {
  if (!uploadedFile) return value || 0;
  const rate = uploadedFile.exchangeRate || 1500;
  const mode = uploadedFile.currencyMode || uploadedFile.detectedCurrency || 'IQD';
  return mode === 'USD' ? (value || 0) * rate : (value || 0);
}

function inc(map, key, qty, value, isReturn) {
  if (!map.has(key)) map.set(key, { name: key, salesQty: 0, salesValue: 0, returnsQty: 0, returnsValue: 0, orders: 0 });
  const o = map.get(key);
  if (isReturn) { o.returnsQty += qty; o.returnsValue += value; }
  else          { o.salesQty   += qty; o.salesValue   += value; o.orders++; }
}

// Convert breakdown Map → sorted plain array
function toArr(map) {
  return [...map.values()]
    .map(o => ({ ...o, netQty: o.salesQty - o.returnsQty, netValue: o.salesValue - o.returnsValue }))
    .sort((a, b) => b.netValue - a.netValue);
}

const FEEDBACK_AR = {
  writing:        'يكتب',
  stocked:        'يحتفظ بالمخزون',
  interested:     'مهتم',
  not_interested: 'غير مهتم',
  unavailable:    'غير متوفر',
  pending:        'بانتظار',
};

// ─── GET /api/item-analysis/items — list items for selector ─
export async function listItems(req, res, next) {
  try {
    const userId = req.user.id;
    const search = req.query.search ? norm(req.query.search) : null;
    const fileIds = req.query.fileIds || null;

    // Use items that actually appear in user's sales (limited by file selection)
    const sales = await prisma.sale.findMany({
      where: { userId, ...buildFileFilter(fileIds) },
      select: { itemId: true },
      distinct: ['itemId'],
    });
    const itemIds = sales.map(s => s.itemId).filter(Boolean);
    if (!itemIds.length) return res.json({ items: [] });

    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, name: true, scientificName: true, dosage: true, form: true, companyId: true },
      orderBy: { name: 'asc' },
    });
    const filtered = search
      ? items.filter(i => norm(i.name).includes(search) || norm(i.scientificName || '').includes(search))
      : items;
    res.json({ items: filtered });
  } catch (e) { next(e); }
}

// ─── GET /api/item-analysis/:itemId — full aggregator ───────
export async function getItemAnalytics(req, res, next) {
  try {
    const userId = req.user.id;
    const itemId = Number(req.params.itemId);
    const fileIds = req.query.fileIds || null;
    const days = Math.max(7, Math.min(730, Number(req.query.days) || 180));
    if (!itemId) return res.status(400).json({ error: 'itemId required' });

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // ── 1. Item core data ──────────────────────────────────
    const item = await prisma.item.findFirst({
      where: { id: itemId },
      include: { company: { select: { id: true, name: true } } },
    });
    if (!item) return res.status(404).json({ error: 'الإيتم غير موجود' });

    // ── 2. Sales (filtered by uploadedFileId + userId + itemId) ──
    const sales = await prisma.sale.findMany({
      where: { userId, itemId, ...buildFileFilter(fileIds) },
      select: {
        quantity: true, totalValue: true, saleDate: true, recordType: true,
        area:           { select: { name: true } },
        representative: { select: { name: true } },
        customer:       { select: { name: true } },
        uploadedFile:   { select: { currencyMode: true, exchangeRate: true, detectedCurrency: true } },
        rawData: true,
      },
    });

    const byArea = new Map(), byRep = new Map(), byPharmacy = new Map(), byMonth = new Map();
    let totalSalesQty = 0, totalSalesValue = 0, totalReturnsQty = 0, totalReturnsValue = 0;
    let firstSaleDate = null, lastSaleDate = null;
    const dedup = new Set();

    for (const s of sales) {
      const iqd = toIQD(s.totalValue, s.uploadedFile);
      const isReturn = s.recordType === 'return';

      // Resolve pharmacy
      let pharma = s.customer?.name;
      if (!pharma && s.rawData) {
        try {
          const r = JSON.parse(s.rawData);
          pharma = r.pharmacyName || r.pharmacy || r.customer || r['اسم الصيدلية'] || r['الصيدلية'] || null;
        } catch {}
      }
      pharma = pharma || 'غير محدد';
      const dateKey = s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : '';
      const dedupKey = [norm(pharma), dateKey, s.quantity, s.totalValue, s.recordType || 'sale'].join('|');
      if (dedup.has(dedupKey)) continue;
      dedup.add(dedupKey);

      if (isReturn) { totalReturnsQty += s.quantity; totalReturnsValue += iqd; }
      else {
        totalSalesQty += s.quantity; totalSalesValue += iqd;
        if (!firstSaleDate || new Date(s.saleDate) < new Date(firstSaleDate)) firstSaleDate = s.saleDate;
        if (!lastSaleDate  || new Date(s.saleDate) > new Date(lastSaleDate))  lastSaleDate  = s.saleDate;
      }

      inc(byArea,     s.area?.name           || 'غير محدد', s.quantity, iqd, isReturn);
      inc(byRep,      s.representative?.name || 'غير محدد', s.quantity, iqd, isReturn);
      inc(byPharmacy, pharma,                                s.quantity, iqd, isReturn);

      const monthKey = dateKey.slice(0, 7); // YYYY-MM
      if (monthKey) inc(byMonth, monthKey, s.quantity, iqd, isReturn);
    }

    // ── 3. Doctor visits for this item (within window) ─────
    const doctorVisits = await prisma.doctorVisit.findMany({
      where: { userId, itemId, visitDate: { gte: since } },
      select: {
        visitDate: true, feedback: true, notes: true, isDoubleVisit: true,
        doctor:        { select: { id: true, name: true, specialty: true, area: { select: { name: true } } } },
        scientificRep: { select: { id: true, name: true } },
      },
      orderBy: { visitDate: 'desc' },
      take: 500,
    });
    const feedbackCounts = {};
    const topDoctors = new Map();
    const topVisitReps = new Map();
    const notesSamples = [];
    for (const v of doctorVisits) {
      const fb = v.feedback || 'pending';
      feedbackCounts[fb] = (feedbackCounts[fb] || 0) + 1;
      const dName = v.doctor?.name || 'غير محدد';
      if (!topDoctors.has(dName)) topDoctors.set(dName, {
        name: dName, specialty: v.doctor?.specialty || '', area: v.doctor?.area?.name || '',
        visits: 0, feedbackSummary: {}, lastVisit: null,
      });
      const d = topDoctors.get(dName);
      d.visits++;
      d.feedbackSummary[fb] = (d.feedbackSummary[fb] || 0) + 1;
      if (!d.lastVisit || v.visitDate > d.lastVisit) d.lastVisit = v.visitDate;
      const rName = v.scientificRep?.name;
      if (rName) {
        topVisitReps.set(rName, (topVisitReps.get(rName) || 0) + 1);
      }
      if (v.notes && v.notes.trim() && notesSamples.length < 25) {
        notesSamples.push({
          doctor: dName,
          feedback: FEEDBACK_AR[fb] || fb,
          date: v.visitDate,
          notes: v.notes.trim().slice(0, 300),
        });
      }
    }

    // ── 4. Pharmacy visits for this item ───────────────────
    const pharmacyVisitItems = await prisma.pharmacyVisitItem.findMany({
      where: { itemId, pharmacyVisit: { userId, visitDate: { gte: since } } },
      select: {
        notes: true, itemName: true,
        pharmacyVisit: {
          select: {
            pharmacyName: true, visitDate: true, notes: true,
            area: { select: { name: true } },
            scientificRep: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const pharmacyVisitsAgg = new Map();
    const pharmacyVisitNotes = [];
    for (const pv of pharmacyVisitItems) {
      const name = pv.pharmacyVisit?.pharmacyName || 'غير محدد';
      if (!pharmacyVisitsAgg.has(name)) pharmacyVisitsAgg.set(name, {
        name, area: pv.pharmacyVisit?.area?.name || '', visits: 0, lastVisit: null,
      });
      const o = pharmacyVisitsAgg.get(name);
      o.visits++;
      const vd = pv.pharmacyVisit?.visitDate;
      if (vd && (!o.lastVisit || vd > o.lastVisit)) o.lastVisit = vd;
      const noteText = pv.notes || pv.pharmacyVisit?.notes;
      if (noteText && pharmacyVisitNotes.length < 15) {
        pharmacyVisitNotes.push({ pharmacy: name, date: vd, notes: String(noteText).slice(0, 300) });
      }
    }

    // ── 5. Competitor benchmark — top 5 items in same company ──
    let competitors = [];
    if (item.companyId) {
      const sibSales = await prisma.sale.groupBy({
        by: ['itemId'],
        where: {
          userId,
          item: { companyId: item.companyId },
          recordType: 'sale',
          ...buildFileFilter(fileIds),
        },
        _sum: { quantity: true, totalValue: true },
      });
      const top = sibSales
        .map(s => ({ itemId: s.itemId, qty: s._sum.quantity || 0, value: s._sum.totalValue || 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 6);
      const sibItems = await prisma.item.findMany({
        where: { id: { in: top.map(t => t.itemId) } },
        select: { id: true, name: true, scientificName: true },
      });
      const byId = new Map(sibItems.map(i => [i.id, i]));
      competitors = top.map(t => ({
        itemId: t.itemId,
        name: byId.get(t.itemId)?.name || '',
        scientificName: byId.get(t.itemId)?.scientificName || '',
        qty: t.qty,
        value: t.value,
        isCurrent: t.itemId === itemId,
      }));
    }

    res.json({
      item: {
        id: item.id, name: item.name, scientificName: item.scientificName,
        dosage: item.dosage, form: item.form, price: item.price,
        scientificMessage: item.scientificMessage, imageUrl: item.imageUrl,
        company: item.company ? { id: item.company.id, name: item.company.name } : null,
      },
      windowDays: days,
      overview: {
        salesQty: totalSalesQty,
        salesValue: totalSalesValue,
        returnsQty: totalReturnsQty,
        returnsValue: totalReturnsValue,
        netQty: totalSalesQty - totalReturnsQty,
        netValue: totalSalesValue - totalReturnsValue,
        ordersCount: sales.filter(s => s.recordType !== 'return').length,
        areasCount: byArea.size,
        repsCount: byRep.size,
        pharmaciesCount: byPharmacy.size,
        doctorsVisitedCount: topDoctors.size,
        totalDoctorVisits: doctorVisits.length,
        totalPharmacyVisits: pharmacyVisitItems.length,
        firstSaleDate, lastSaleDate,
      },
      salesByArea:  toArr(byArea).slice(0, 25),
      salesByRep:   toArr(byRep).slice(0, 25),
      salesByMonth: toArr(byMonth).sort((a, b) => a.name.localeCompare(b.name)),
      topPharmacies: toArr(byPharmacy).slice(0, 15),
      doctorVisits: {
        total: doctorVisits.length,
        feedbackCounts,
        feedbackLabels: FEEDBACK_AR,
        topDoctors: [...topDoctors.values()].sort((a, b) => b.visits - a.visits).slice(0, 15),
        topReps: [...topVisitReps.entries()].map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count).slice(0, 10),
        notesSamples,
      },
      pharmacyVisits: {
        total: pharmacyVisitItems.length,
        topPharmacies: [...pharmacyVisitsAgg.values()].sort((a, b) => b.visits - a.visits).slice(0, 15),
        notesSamples: pharmacyVisitNotes,
      },
      competitors,
    });
  } catch (e) { next(e); }
}

// ─── POST /api/item-analysis/:itemId/ai-insight ─────────────
export async function getAIInsight(req, res, next) {
  try {
    const userId = req.user.id;
    const itemId = Number(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const { fileIds = null, days = 180 } = req.body || {};

    // Re-run aggregator inline to get fresh data
    req.params.itemId = itemId;
    req.query.fileIds = fileIds || '';
    req.query.days = days;

    // Capture aggregator output without sending response
    let aggregated = null;
    const fakeRes = {
      status() { return this; },
      json(d) { aggregated = d; return this; },
    };
    await getItemAnalytics({ user: { id: userId }, params: req.params, query: req.query }, fakeRes, next);
    if (!aggregated || aggregated.error) {
      return res.status(404).json({ error: aggregated?.error || 'فشل تجميع البيانات' });
    }

    // Slim down aggregated for prompt
    const slim = {
      item: aggregated.item,
      windowDays: aggregated.windowDays,
      overview: aggregated.overview,
      topAreas: aggregated.salesByArea.slice(0, 10),
      bottomAreas: [...aggregated.salesByArea].reverse().slice(0, 5),
      topReps: aggregated.salesByRep.slice(0, 10),
      bottomReps: [...aggregated.salesByRep].reverse().slice(0, 5),
      monthlyTrend: aggregated.salesByMonth.slice(-12),
      topPharmacies: aggregated.topPharmacies.slice(0, 10),
      doctorVisits: {
        total: aggregated.doctorVisits.total,
        feedbackCounts: aggregated.doctorVisits.feedbackCounts,
        topDoctors: aggregated.doctorVisits.topDoctors.slice(0, 10),
        notesSamples: aggregated.doctorVisits.notesSamples.slice(0, 15),
      },
      pharmacyVisits: aggregated.pharmacyVisits,
      competitors: aggregated.competitors,
    };

    const it = slim.item;
    const prompt = `أنت محلل مبيعات أدوية خبير ومستشار طبي. حلل أداء الإيتم التالي تحليلاً عميقاً وشاملاً ومنظماً بالعربية الفصحى.

# بيانات الإيتم
- الاسم التجاري: ${it.name}
- الاسم العلمي: ${it.scientificName || 'غير محدد'}
- الجرعة: ${it.dosage || 'غير محدد'}
- الشكل الدوائي: ${it.form || 'غير محدد'}
- السعر: ${it.price ?? 'غير محدد'}
- الشركة: ${it.company?.name || 'غير محدد'}
- الرسالة العلمية المسجّلة: ${it.scientificMessage || 'لا توجد'}

# نافذة التحليل
آخر ${slim.windowDays} يوم.

# ملخص الأداء
${JSON.stringify(slim.overview, null, 2)}

# أعلى المناطق مبيعاً
${JSON.stringify(slim.topAreas, null, 2)}

# أضعف المناطق
${JSON.stringify(slim.bottomAreas, null, 2)}

# أعلى المندوبين مبيعاً
${JSON.stringify(slim.topReps, null, 2)}

# أضعف المندوبين
${JSON.stringify(slim.bottomReps, null, 2)}

# التطور الشهري
${JSON.stringify(slim.monthlyTrend, null, 2)}

# أعلى الصيدليات شراءً
${JSON.stringify(slim.topPharmacies, null, 2)}

# زيارات الأطباء لهذا الإيتم
${JSON.stringify(slim.doctorVisits, null, 2)}

# زيارات الصيدليات
${JSON.stringify(slim.pharmacyVisits, null, 2)}

# منافسون داخل نفس الشركة (مقارنة مرجعية)
${JSON.stringify(slim.competitors, null, 2)}

# المطلوب
اكتب تقريراً منظماً بصيغة Markdown يحوي الأقسام التالية بالضبط (مع العنوان والإيموجي):

## 💊 المعلومات العلمية عن الدواء
استنتج من الاسم التجاري والعلمي والجرعة: المكونات الفعالة، آلية العمل، الاستخدامات والأمراض المعالجة، الفئة العلاجية، التداخلات الدوائية الأهم، الفئات العمرية المستهدفة، نقاط القوة العلمية مقارنة بالبدائل، الأطباء الذين يصفونه عادةً (التخصصات).

## 🔍 تشخيص سبب ضعف المبيع
حلل البيانات (لا تكتفِ بالأرقام، استنتج الأسباب الجذرية): مقارنة مع المنافسين، تحليل المناطق الضعيفة، أداء المندوبين، الموسمية، علاقة الفيدباك بالمبيعات.

## 🩺 تحليل سلوك الأطباء
كم نسبة "يكتب" مقابل "غير مهتم"؟ ماذا تقول ملاحظات الزيارات؟ ما الأنماط؟ أين الفرص؟ أي تخصصات تستجيب أكثر؟

## 🏪 تحليل الصيدليات
أيهما نشط وأيها خامل؟ ما تردد الزيارات؟ ملاحظات الصيادلة.

## 🎯 اقتراحات عملية للمندوب (5-7 نقاط مرقّمة وقابلة للتنفيذ)
رسائل علمية محددة، استراتيجيات الزيارة، مناطق وأطباء يحتاجون تركيز، التعامل مع الاعتراضات الشائعة.

## 📅 خطة عمل 30 يوم
جدول | الأسبوع | الإجراء | المخرج المتوقع |

اجعل التقرير دقيقاً وعملياً ومبنياً على البيانات أعلاه. تجنّب العموميات. استشهد بأرقام محددة. اكتب كأنك تخاطب فريق مبيعات يريد رفع أداء هذا الإيتم خلال الشهر القادم.`;

    let insight;
    try {
      insight = await callGeminiSmart([{ text: prompt }]);
    } catch (err) {
      console.error('[item-analysis] Gemini failed:', err?.message);
      return res.status(503).json({ error: 'خدمة الذكاء الاصطناعي غير متوفرة حالياً. الرجاء المحاولة لاحقاً.' });
    }

    res.json({
      itemId,
      itemName: it.name,
      insight,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
}
