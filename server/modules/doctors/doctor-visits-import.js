/**
 * استيراد زيارات الأطباء والصيدليات بالجملة من ملف إكسل خارجي — بديل عن
 * تسجيلها يدوياً واحدة تلو الأخرى من داخل التطبيق.
 *
 * يدعم صيغتين للملف (تُكتشَف تلقائياً من ترويسات الأعمدة):
 *   • القالب البسيط (نموذجنا القابل للتحميل من داخل التطبيق) — أعمدة عربية
 *     صريحة (اسم المندوب/اسم الطبيب/الاختصاص...) → زيارات أطباء فقط.
 *   • تصدير CRM خارجي (task-to/client/client-category...) — ملف واحد يخلط
 *     زيارات أطباء وصيدليات معاً، يُميَّز بينها بعمود client-category؛ يُقسَّم
 *     هنا إلى قائمتين منفصلتين لأن DoctorVisit وPharmacyVisit نموذجان مختلفان
 *     تماماً (لا طبيب في زيارة الصيدلية، ولا "اختصاص" لها).
 *
 * تدفّق العمل على مرحلتين (مطابق لنمط ManualSalesModal):
 *   1) extractVisitsFromExcel — يقرأ الملف، يحاول مطابقة كل حقل تلقائياً، ويُعيد
 *      الصفوف (أطباء + صيدليات) للمراجعة — لا يُنشئ شيئاً.
 *   2) commitVisitsImport — يأخذ الصفوف بعد مراجعة المستخدم وتصحيحها، وينشئ
 *      صفوف Doctor الناقصة + DoctorVisit/PharmacyVisit فعلياً.
 *
 * مطابقة اسم المندوب تُعاد استعمالها من محرّك ميركاتو (classifyRepNamesForUser)
 * عمداً: نفس السؤال بالضبط ("هل هذا الاسم الحر هو المندوب فلان؟")، وأي رابط
 * يؤكّده المستخدم هنا يُطبَّق تلقائياً لاحقاً في ميركاتو أو أي استيراد آخر.
 */

import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';
import fs from 'fs';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import { resolveDocOwnerUserId } from './doctors.controller.js';
import { classifyRepNamesForUser, normalizeRepName, repNameScore, saveRepNameLinks } from '../scientific-reps/scientific-reps.service.js';
import { createSurveyDoctor } from '../../lib/surveyDoctors.js';

// ── تعيين نص الفيدباك الحر إلى قيم Enum الثابتة في DoctorVisit.feedback ──────
const FEEDBACK_RULES = [
  [/كتاب|writing/i,                         'writing'],
  [/مخزن|تخزين|متوفر|stock/i,                'stocked'],
  [/غير\s*مهتم|not[\s_]*interested/i,        'not_interested'],
  [/مهتم|interested/i,                       'interested'],
  [/غير\s*متوفر|unavailable/i,               'unavailable'],
];
function mapFeedback(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'pending';
  for (const [re, val] of FEEDBACK_RULES) if (re.test(s)) return val;
  return 'pending';
}

const COL_KEYWORDS = {
  repName:   ['اسم المندوب', 'المندوب', 'rep name', 'sales rep', 'rep'],
  doctor:    ['اسم الطبيب', 'اسم الدكتور', 'الطبيب', 'الدكتور', 'doctor name', 'doctor'],
  specialty: ['الاختصاص', 'التخصص', 'اختصاص', 'تخصص', 'specialty', 'speciality'],
  area:      ['المنطقة', 'منطقة', 'المنطقه', 'منطقه', 'area', 'zone', 'region'],
  pharmacy:  ['اسم الصيدلية', 'الصيدلية', 'صيدلية', 'صيدليه', 'pharmacy'],
  item:      ['اسم الايتم', 'الايتم', 'ايتم', 'المادة', 'الماده', 'item', 'drug', 'product'],
  date:      ['تاريخ الزيارة', 'التاريخ', 'تاريخ', 'date'],
  feedback:  ['الفيدباك', 'فيدباك', 'نتيجة الزيارة', 'النتيجة', 'feedback', 'result'],
  notes:     ['الملاحظات', 'ملاحظات', 'ملاحظة', 'notes', 'note'],
  lat:       ['خط العرض', 'latitude', 'lat'],
  lng:       ['خط الطول', 'longitude', 'lng', 'long'],
  location:  ['الموقع', 'الإحداثيات', 'الاحداثيات', 'location', 'gps', 'coordinates'],
};

function findCol(headers, keywords) {
  const lower = headers.map(h => String(h).trim().toLowerCase());
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    let idx = lower.findIndex(h => h === k);
    if (idx === -1) idx = lower.findIndex(h => h.includes(k));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

/** رقم إكسل التسلسلي للتاريخ → Date (المرجع 1899-12-30 = 25569 يوماً قبل عهد يونكس). */
function excelSerialToDate(n) {
  const d = new Date(Math.round((n - 25569) * 86400 * 1000));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * حارس عقل: أي تاريخ خارج المدى الواقعي للزيارات يُرفَض بدل تمريره إلى قاعدة
 * البيانات. سبب وجوده: خلية إكسل مخزَّنة كـ«نص» تحمل الرقم التسلسلي (مثل
 * "46236") كان `new Date("46236")` يقرأها كـ«السنة 46236»، فيُنشأ تاريخ صالح
 * ظاهرياً لكن Prisma ترفضه لاحقاً برسالة
 * `Could not convert argument value … "+046236-01-01T00:00:00.000Z"` وتفشل كل
 * صفوف الملف. المدى 1990..2100 يغطي أي زيارة حقيقية بفارق أمان واسع.
 */
const MIN_VISIT_YEAR = 1990;
const MAX_VISIT_YEAR = 2100;
function inVisitRange(d) {
  if (!d || isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  return (y >= MIN_VISIT_YEAR && y <= MAX_VISIT_YEAR) ? d : null;
}

function parseVisitDate(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return inVisitRange(v);
  if (typeof v === 'number') return inVisitRange(excelSerialToDate(v)); // رقم إكسل تسلسلي
  const s = String(v).trim();
  if (!s) return null;
  // نص يحتوي رقماً فقط = خلية تاريخ مخزَّنة كنص في إكسل → رقم تسلسلي لا «سنة».
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 80000) return inVisitRange(excelSerialToDate(n)); // مدى تواريخ معقول (1954..2119)
    return null;
  }
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (dmy) { const d = new Date(+dmy[3], +dmy[2] - 1, +dmy[1]); if (!isNaN(d.getTime())) return inVisitRange(d); }
  const ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (ymd) { const d = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]); if (!isNaN(d.getTime())) return inVisitRange(d); }
  const generic = new Date(s);
  return inVisitRange(generic);
}

/** Date → "YYYY-MM-DD" بالتوقيت المحلي — toISOString يزيح التاريخ يوماً كاملاً للخلف
 *  عند منتصف الليل المحلي في التوقيت العراقي (UTC+3)، فيظهر تاريخ الزيارة خاطئاً. */
function toDateInput(d) {
  if (!d || isNaN(d.getTime())) return '';
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

function parseLocation(row, colMap) {
  let lat = colMap.lat ? Number(row[colMap.lat]) : NaN;
  let lng = colMap.lng ? Number(row[colMap.lng]) : NaN;
  if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && colMap.location) {
    const raw = String(row[colMap.location] ?? '').trim();
    const m = raw.match(/(-?\d+(?:\.\d+)?)\s*[,،]\s*(-?\d+(?:\.\d+)?)/);
    if (m) { lat = Number(m[1]); lng = Number(m[2]); }
  }
  return { lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null };
}

function findByName(list, val) {
  if (!val) return null;
  const v = String(val).trim().toLowerCase();
  if (!v) return null;
  return list.find(x => x.name.trim().toLowerCase() === v)
      || list.find(x => x.name.toLowerCase().includes(v) || v.includes(x.name.toLowerCase()))
      || null;
}

// ════════════════════════════════════════════════════════════════════════════
// صيغة تصدير CRM خارجي (task-to/client/client-category…)
// ════════════════════════════════════════════════════════════════════════════

// توقيع الصيغة: هذه الأعمدة الثلاثة معاً لا تظهر في القالب البسيط إطلاقاً.
const CRM_SIGNATURE = ['task-to', 'client', 'client-category'];
function detectCrmFormat(headers) {
  const lower = headers.map(h => String(h).trim().toLowerCase());
  return CRM_SIGNATURE.every(c => lower.includes(c));
}

/**
 * بعض أعمدة CRM تخلط الاسم بمعلومات إضافية بفاصل ("الاسم - المدينة" أو
 * "الاسم / الشركة / المنطقة") — نأخذ المقطع الأول فقط قبل أول فاصل.
 */
function leadingSegment(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(.+?)\s*[/\-–]\s*\S.*$/);
  return m ? m[1].trim() : s;
}

const PHARMACY_NAME_RE = /^(صيدلية|صيدليه|ص[.\s])/;
const DOCTOR_NAME_RE   = /(دكتور|عيادة|د\.)/;

// CRM يكتب اسم الطبيب أحياناً "عيادة الدكتور فلان" بدل "فلان" وحدها — لو تُرك
// كما هو، لا يطابق السجل الصافي الموجود أصلاً فيُنشئ طبيباً مكرَّراً بلا زيارات
// تحت الاسم القديم، بينما الزيارة الجديدة تعلَّق على سجل جديد منفصل. نفس فكرة
// PHARMACY_PREFIX_RE في sales.service.js لكن لأسماء الأطباء.
const DOCTOR_PREFIX_RE = /^\s*(عيادة\s+)?(الدكتور|دكتور|د\.?)\s+/i;
function cleanDoctorName(name) {
  let s = String(name ?? '').trim();
  for (let i = 0; i < 3 && DOCTOR_PREFIX_RE.test(s); i++) s = s.replace(DOCTOR_PREFIX_RE, '').trim();
  return s;
}

// ════════════════════════════════════════════════════════════════════════════
// تحليل حقل note في صيغة CRM — منه نستخرج الايتم المستهدف + ملاحظات الزيارة
// ════════════════════════════════════════════════════════════════════════════
/*
 * الحقل ليس ملاحظة واحدة، بل سلسلة تعليقات متلاحقة يفصل بينها «***»، كل تعليق:
 *     *** <الكاتب: مندوب / منطقة / شركة> *** <النص>(dd/mm/yyyy hh:mm AM/PM)
 * ويلصق الـCRM بذيل النص تغييرات حالته بلا أي فاصل:
 *     …كول بخصوص pantactiveStatus: Pending -> CompletedClient: Unset -> عيادة…
 *
 * وللنصوص شكلان مختلفان تماماً:
 *   • «سطر خطة» مفصول بـ \  آخرُ مقطع فيه هو الايتم المستهدف:
 *       د. ضياء الراوي \ medicine \ كنز الجامعة \ ص. حي الجامعة \ pantactive(10/05/2026 07:45 PM)
 *     (وقد يخلو من الايتم فينتهي باسم صيدلية/منطقة — لذلك يُشترط أن يكون المقطع
 *      الأخير لاتينياً: أسماء المواد في هذه الملفات تُكتب بالإنجليزية دائماً،
 *      بينما الأطباء/الصيدليات/المناطق بالعربية.)
 *   • تعليق حرّ يكتبه المندوب: «كول بخصوص pantactive,uricodrop» أو
 *     «تم زيارة الدكتور عاصم الشمري من اجل مادة airtide» → هذه هي الملاحظات،
 *     والايتم فيها يلي كلمة «مادة/بخصوص».
 *
 * فنُخرج ثلاثة أشياء: الايتم (يُطابَق بكتالوج الحساب متى أمكن)، والملاحظات
 * الحرّة منظّفة من الكاتب والتوقيت وتغييرات الحالة، وتوقيتاً احتياطياً يُستعمل
 * تاريخاً للزيارة حين يغيب عمود created أو يتعذّر قراءته.
 */

const NOTE_TS_RE      = /\(\s*(\d{1,2}\/\d{1,2}\/\d{4}[^)]*)\)/g;         // (19/08/2026 11:19 PM)
const NOTE_META_RE    = /(?:associated\s+client|client|status|assigned\s*to|type)\s*:/i; // ذيل يولّده CRM
const NOTE_ITEM_KW_RE = /(?:من\s*اجل\s*مادة|بخصوص\s*مادة|مادة\s*ال|مادة|بخصوص)\s*(?:ال\s*)?([A-Za-z][A-Za-z0-9.\- ]{1,40})/i;

/** مقطع «الكاتب» بين نجمتين: «محمود بلال / الكرخ / فارماكتف» — يُطرح من الملاحظات. */
function isNoteAuthorSegment(seg) {
  return seg.length <= 80
    && (seg.match(/\//g) || []).length >= 2
    && !/[\\()]/.test(seg)
    && !NOTE_META_RE.test(seg)
    && !/\d{1,2}\/\d{1,2}\/\d{4}/.test(seg);
}

/** يقصّ ذيل بيانات CRM الملصوق بلا فاصل (Status:/Client:/Associated client:). */
function stripNoteMeta(text) {
  const m = text.match(NOTE_META_RE);
  return (m ? text.slice(0, m.index) : text).trim();
}

const normItemText = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
/** اسم لاتيني قصير = اسم مادة؛ العربي هنا يعني طبيباً/صيدلية/منطقة لا ايتم. */
const looksLikeItemToken = s => /[A-Za-z]/.test(s) && !/[؀-ۿ]/.test(s) && s.trim().length >= 3;

/** يربط نصاً باسم ايتم من كتالوج الحساب (تطابق تام ثم احتواء، الأطول أولاً). */
function matchItemByText(items, text) {
  const t = normItemText(text);
  if (!t) return null;
  const exact = items.find(it => normItemText(it.name) === t);
  if (exact) return exact;
  if (t.length < 3) return null; // نص قصير جداً يطابق كل شيء بالاحتواء — لا نخمّن
  return [...items]
    .filter(it => normItemText(it.name).length >= 3)
    .sort((a, b) => b.name.length - a.name.length)
    .find(it => t.includes(normItemText(it.name)) || normItemText(it.name).includes(t)) ?? null;
}

/** يبحث عن أي اسم ايتم من الكتالوج داخل نص الملاحظة كاملاً (الأطول أولاً). */
function scanNoteForCatalogItem(items, note) {
  const t = normItemText(note);
  if (!t) return null;
  return [...items]
    .filter(it => normItemText(it.name).length >= 3)
    .sort((a, b) => b.name.length - a.name.length)
    .find(it => t.includes(normItemText(it.name))) ?? null;
}

/**
 * يحلّل حقل note ويُعيد { itemName, itemId, notes, timestamp }.
 * لا يرمي أبداً: أي شكل غير متوقَّع يرجع بالملاحظة الخام كما هي (أسوأ حالة =
 * السلوك القديم بالضبط) بدل إسقاط بيانات الصف.
 */
function parseCrmNote(rawNote, items = []) {
  const raw = String(rawNote ?? '').replace(/\r/g, ' ').trim();
  const empty = { itemName: '', itemId: null, notes: raw, timestamp: '' };
  if (!raw) return { ...empty, notes: '' };

  const firstTs = raw.match(/\(\s*(\d{1,2}\/\d{1,2}\/\d{4}[^)]*)\)/);
  const timestamp = firstTs ? firstTs[1].trim() : '';

  const segments = raw.split(/\*{3,}/).map(s => s.trim()).filter(Boolean);
  const freeTexts = [];
  let planItem = '';

  for (const seg of segments) {
    if (isNoteAuthorSegment(seg)) continue;                 // مقطع الكاتب
    const body = stripNoteMeta(seg).replace(NOTE_TS_RE, '').trim();
    if (!body) continue;
    if ((body.match(/\\/g) || []).length >= 2) {            // سطر خطة مفصول بـ \
      const last = body.split('\\').pop().trim();
      if (!planItem && looksLikeItemToken(last)) planItem = last;
      continue;                                             // بيانات توجيه لا ملاحظة
    }
    freeTexts.push(body.replace(/\s{2,}/g, ' '));
  }

  // الايتم: هدف سطر الخطة أولاً (هو «الايتم المستهدف» صراحةً)، ثم ما يلي كلمة
  // «مادة/بخصوص» في التعليق الحر، ثم أي اسم ايتم من الكتالوج داخل النص كله.
  let itemText = planItem;
  if (!itemText) {
    for (const t of freeTexts) {
      const m = t.match(NOTE_ITEM_KW_RE);
      if (m && looksLikeItemToken(m[1])) { itemText = m[1].trim().replace(/[.,;]+$/, ''); break; }
    }
  }
  let item = itemText ? matchItemByText(items, itemText) : null;
  if (!item && !itemText) { item = scanNoteForCatalogItem(items, raw); if (item) itemText = item.name; }

  const notes = freeTexts.join(' | ').trim();
  // صيغة غير متوقَّعة تماماً (بلا *** ولا نص مفهوم) → نُبقي الملاحظة الخام بدل ضياعها.
  if (!notes && !itemText && !raw.includes('***')) return empty;

  return { itemName: item ? item.name : itemText, itemId: item?.id ?? null, notes, timestamp };
}

/** يقرأ صفوف صيغة CRM ويقسّمها إلى زيارات أطباء وزيارات صيدليات منفصلة. */
function extractCrmRows({ rows, headers, repByKey, allAreas, allItems = [] }) {
  const col = {
    taskTo:      findCol(headers, ['task-to']),
    client:      findCol(headers, ['client']),
    category:    findCol(headers, ['client-category']),
    subcategory: findCol(headers, ['client-subcategory']),
    address:     findCol(headers, ['client-address']),
    city:        findCol(headers, ['client-city']),
    associated:  findCol(headers, ['associated-client']),
    type:        findCol(headers, ['type']),
    created:     findCol(headers, ['created']),
    note:        findCol(headers, ['note']),
  };
  const get = (row, key) => (col[key] ? String(row[col[key]] ?? '').trim() : '');

  const doctorRows = [];
  const pharmacyRows = [];

  rows.forEach((row, i) => {
    const clientRaw = get(row, 'client');
    if (!clientRaw) return; // صفوف مثل Check-Out بلا عميل — لا معنى لاستيرادها

    const repName = leadingSegment(get(row, 'taskTo'));
    const repKey  = repName ? normalizeRepName(repName) : '';
    const rep     = repKey ? repByKey.get(repKey) : null;

    const clientName = leadingSegment(clientRaw);
    let category = get(row, 'category');
    if (!category || category.toLowerCase() === 'unset') {
      category = PHARMACY_NAME_RE.test(clientName) ? 'صيدلية'
               : DOCTOR_NAME_RE.test(clientName)   ? 'دكتور'
               : '';
    }

    const areaRaw = get(row, 'address') || get(row, 'city');
    const area = findByName(allAreas, areaRaw);
    // حقل note ثريّ: منه الايتم المستهدف والملاحظات، ومنه أيضاً توقيت يصلح
    // تاريخاً للزيارة حين يغيب عمود created (بعض التصديرات لا تتضمنه أصلاً).
    const parsedNote = parseCrmNote(get(row, 'note'), allItems);
    const dateVal = parseVisitDate(get(row, 'created')) || parseVisitDate(parsedNote.timestamp);
    const date = toDateInput(dateVal) || '';
    const isDoubleVisit = get(row, 'type') === 'Double Visit';
    const notes = parsedNote.notes;
    const _row = i + 2;

    if (category.includes('صيدل')) {
      pharmacyRows.push({
        _row, repName, repId: rep?.id ?? null,
        pharmacyName: clientName,
        areaName: areaRaw, areaId: area?.id ?? null,
        itemName: parsedNote.itemName, itemId: parsedNote.itemId,
        date, notes, isDoubleVisit,
        lat: null, lng: null,
      });
    } else {
      // فئة غير محسومة (لا "دكتور" صريحة ولا شبه اسم صيدلية) تُعامَل كطبيب
      // افتراضياً لتبقى قابلة للمراجعة بدل إسقاطها صامتة.
      // "عيادة الدكتور فلان" → "فلان": الاسم الصافي هو ما يُطابَق ويُخزَّن، وإلا
      // أُنشئ طبيب مكرَّر بلا صلة بالسجل الصافي الموجود أصلاً لنفس الشخص.
      // المطابقة الفعلية (تامة/تشابه/سؤال المستخدم) تتم لاحقاً دفعة واحدة عبر
      // classifyDoctorRows — هنا فقط تنظيف الاسم.
      const doctorName = cleanDoctorName(clientName);
      doctorRows.push({
        _row, repName, repId: rep?.id ?? null,
        doctorName, doctorId: null,
        specialty: get(row, 'subcategory'),
        areaName: areaRaw, areaId: area?.id ?? null,
        pharmacyName: get(row, 'associated'),
        itemName: parsedNote.itemName, itemId: parsedNote.itemId,
        date,
        feedback: 'pending', // لا مصدر واثق للفيدباك في نص هذه الصيغة الحر
        notes, isDoubleVisit,
        lat: null, lng: null,
      });
    }
  });

  return { doctorRows, pharmacyRows };
}

// ════════════════════════════════════════════════════════════════════════════
// مطابقة أسماء الأطباء (مشتركة بين الصيغتين) — تُجرى دفعة واحدة على كل صفوف
// الأطباء المستخرجة، بعد بنائها، تماماً كمطابقة أسماء المندوبين. الفكرة:
// الاسم وحده قد لا يكفي لحسم الهوية (نفس الاسم لطبيبين مختلفين، أو نفس الطبيب
// بتهجئة مختلفة قليلاً) — فنستعين بالمنطقة/الاختصاص/الصيدلية كأدلة إضافية.
// ════════════════════════════════════════════════════════════════════════════

/** مفتاح تصنيف موحّد للاسم — نفس المفتاح يُستخدم عند القراءة وعند حفظ الرابط لاحقاً. */
function doctorLinkKey(name, areaName) {
  return `${normalizeRepName(cleanDoctorName(name))}|${normalizeAreaName(areaName || '')}`;
}

/**
 * درجة تطابق طبيب واحدة (0..1): الاسم هو الأساس (نفس محرك تشابه أسماء
 * المندوبين — كلمتان مشتركتان على الأقل)، وتُضاف نقاط ترجيح عند تطابق
 * المنطقة/الاختصاص/الصيدلية أيضاً — هذه هي "تفاصيل الاسم الإضافية" التي تساعد
 * على تأكيد المطابقة عند الشك في الاسم وحده.
 */
function doctorMatchScore(cand, target) {
  const nameScore = repNameScore(cand.name, target.name);
  if (nameScore === 0) return 0; // بلا كلمتين مشتركتين على الأقل — ليسا نفس الشخص مهما تشابهت باقي الحقول
  let bonus = 0;
  if (cand.areaName && target.areaName && normalizeAreaName(cand.areaName) === normalizeAreaName(target.areaName)) bonus += 0.12;
  if (cand.specialty && target.specialty && normalizeRepName(cand.specialty) === normalizeRepName(target.specialty)) bonus += 0.08;
  if (cand.pharmacyName && target.pharmacyName && normalizeRepName(cand.pharmacyName) === normalizeRepName(target.pharmacyName)) bonus += 0.05;
  return Math.min(1, nameScore + bonus);
}

const DOCTOR_ASK_FLOOR = 0.45; // أدنى نقاط يُعتَد بها كمرشَّح يُعرض للمستخدم — أقل من هذا لا صلة له بالاسم أصلاً

/**
 * تصنّف كل أسماء الأطباء في doctorRows دفعة واحدة (مجموعة واحدة لكل اسم+منطقة
 * مختلفين، لا لكل صف) مقابل أطباء هذا المالك + الروابط المحفوظة مسبقاً، وتملأ
 * doctorId مباشرة في الصفوف عند الحسم. لا تُنشئ ولا تحفظ شيئاً — قراءة فقط.
 *
 * التصنيف (يطابق فلسفة classifyRepNamesForUser تماماً):
 *   linked → رابط محفوظ مسبقاً لنفس الاسم (بما فيها "ليس أياً منهم" → null) → بلا سؤال
 *   exact  → اسم مطابق تماماً بعد التنظيف، ولطبيب واحد لا لبس فيه → بلا سؤال
 *   ask    → مرشّحون بدرجة معتد بها لكن بلا حسم (أو أكثر من مطابقة تامة بلا تمييز) → يُعرض للمستخدم مع كل تفاصيله
 *   none   → لا مرشّح على الإطلاق → طبيب جديد بلا سؤال
 */
async function classifyDoctorRows(doctorRows, ownerUserId) {
  const rowsWithName = (doctorRows || []).filter(r => String(r?.doctorName ?? '').trim());
  if (rowsWithName.length === 0) return { doctorNames: { pending: [], resolved: [], unrelated: [] } };

  const [links, existingDoctorsFull] = await Promise.all([
    prisma.doctorNameLink.findMany({
      where: { userId: ownerUserId },
      select: { fromKey: true, doctorId: true, doctor: { select: { id: true, name: true } } },
    }),
    prisma.doctor.findMany({
      where: { userId: ownerUserId },
      select: { id: true, name: true, specialty: true, pharmacyName: true, area: { select: { name: true } } },
    }),
  ]);
  const linkByKey = new Map(links.map(l => [l.fromKey, l]));
  const candidates = existingDoctorsFull.map(d => ({
    id: d.id, name: d.name, specialty: d.specialty, pharmacyName: d.pharmacyName, areaName: d.area?.name ?? null,
  }));

  // تجميع الصفوف حسب مفتاح التصنيف — يكفي تصنيف كل اسم مختلف مرة واحدة، ثم تُطبَّق
  // النتيجة على كل صفوفه دفعة واحدة (تماماً كتجميع أسماء المندوبين في الواجهة).
  const groups = new Map();
  for (const r of rowsWithName) {
    const key = doctorLinkKey(r.doctorName, r.areaName);
    if (!groups.has(key)) {
      groups.set(key, {
        key, raw: r.doctorName, cleanedName: cleanDoctorName(r.doctorName),
        areaName: r.areaName || '', specialty: r.specialty || '', pharmacyName: r.pharmacyName || '',
        rows: [],
      });
    }
    groups.get(key).rows.push(r);
  }

  const pending = [], resolved = [], unrelated = [];

  for (const g of groups.values()) {
    // تُلصَق بكل صفوف المجموعة بصرف النظر عن نتيجة التصنيف — الواجهة تستعملها
    // لتجميع/تطبيق قرار المستخدم على صفوفها دون إعادة تنفيذ منطق التطبيع محلياً.
    for (const r of g.rows) r.doctorKey = g.key;

    const link = linkByKey.get(g.key);
    if (link) {
      for (const r of g.rows) {
        r.doctorId = link.doctorId ?? null;
        // الاسم المعروض يصير اسم الطبيب كما هو في التطبيق — تهجئة الملف تُحفظ
        // في rawDoctorName للاطلاع فقط، ولا تُكتب فوق اسم الطبيب أبداً.
        if (link.doctor) { r.rawDoctorName = r.doctorName; r.doctorName = link.doctor.name; }
      }
      resolved.push({ raw: g.raw, key: g.key, status: 'linked', doctor: link.doctor ? { id: link.doctor.id, name: link.doctor.name } : null });
      continue;
    }

    const cleanNorm = normalizeRepName(g.cleanedName);
    const exactMatches = candidates.filter(c => normalizeRepName(c.name) === cleanNorm);
    let exact = null;
    if (exactMatches.length === 1) exact = exactMatches[0];
    else if (exactMatches.length > 1 && g.areaName) {
      const areaMatches = exactMatches.filter(c => c.areaName && normalizeAreaName(c.areaName) === normalizeAreaName(g.areaName));
      if (areaMatches.length === 1) exact = areaMatches[0];
    }
    if (exact) {
      for (const r of g.rows) { r.doctorId = exact.id; r.rawDoctorName = r.doctorName; r.doctorName = exact.name; }
      resolved.push({ raw: g.raw, key: g.key, status: 'exact', doctor: { id: exact.id, name: exact.name } });
      continue;
    }

    // اسم متطابق تماماً لكن أكثر من طبيب بالاسم نفسه بالضبط ولا يمكن حسم الفرق
    // بالمنطقة — نعرضه للمستخدم بدل التخمين بينهم (بثقة 100% لكل مرشّح).
    const scored = exactMatches.length > 1
      ? exactMatches.map(c => ({ ...c, score: 1 }))
      : candidates
          .map(c => ({ ...c, score: doctorMatchScore({ name: g.cleanedName, areaName: g.areaName, specialty: g.specialty, pharmacyName: g.pharmacyName }, c) }))
          .filter(c => c.score >= DOCTOR_ASK_FLOOR)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

    for (const r of g.rows) r.doctorId = null;
    if (scored.length === 0) {
      unrelated.push({ raw: g.raw, key: g.key });
    } else {
      pending.push({
        raw: g.raw, key: g.key, areaName: g.areaName, specialty: g.specialty, pharmacyName: g.pharmacyName,
        suggestions: scored.map(c => ({ id: c.id, name: c.name, score: c.score, areaName: c.areaName, specialty: c.specialty, pharmacyName: c.pharmacyName })),
      });
    }
  }

  const byName = (a, b) => a.raw.localeCompare(b.raw, 'ar');
  return {
    doctorNames: {
      pending: pending.sort(byName),
      resolved: resolved.sort(byName),
      unrelated: unrelated.sort(byName),
    },
  };
}

/**
 * يحفظ قرارات المستخدم في مطابقة أسماء الأطباء — نفس فلسفة saveRepNameLinks.
 * doctorId = null يعني «تأكَّد المستخدم أنه ليس أياً من المرشَّحين» فيُحفظ أيضاً
 * كي لا يتكرّر السؤال، وسيُنشأ طبيب جديد لهذا الاسم دائماً. needsReview يُضبَط
 * فقط عند الإنشاء لأول مرة (لا يُعاد ضبطه عند إعادة استخدام رابط سبق مراجعته)،
 * لأن هذا بالتحديد "تطابق فيه شك ولو بسيط" الذي طلب المستخدم عرضه على الماستر
 * أدمن — رابط برفض المرشّحين (doctorId=null) ليس فيه تطابق أصلاً فلا يحتاج مراجعة.
 */
export async function saveDoctorNameLinks(userId, links) {
  let saved = 0;
  for (const l of (Array.isArray(links) ? links : [])) {
    const fromName = String(l?.fromName ?? '').trim();
    const fromKey = doctorLinkKey(fromName, l?.areaName);
    if (!fromName || !normalizeRepName(cleanDoctorName(fromName))) continue;
    const doctorId = Number.isInteger(l?.doctorId) ? l.doctorId : null;
    await prisma.doctorNameLink.upsert({
      where:  { userId_fromKey: { userId, fromKey } },
      update: { fromName, areaName: l?.areaName || null },
      create: { userId, fromKey, fromName, areaName: l?.areaName || null, doctorId, confidence: 'confirmed', needsReview: doctorId != null },
    });
    saved++;
  }
  return { saved };
}

// ════════════════════════════════════════════════════════════════════════════
// EXTRACT (مشترك بين الصيغتين)
// ════════════════════════════════════════════════════════════════════════════

/**
 * قراءة الملف ومحاولة مطابقة كل حقل — بلا إنشاء أي شيء. النتيجة صفوف تُعرض
 * لمراجعة المستخدم في شبكة قابلة للتعديل قبل الحفظ الفعلي. يكتشف صيغة الملف
 * تلقائياً (قالبنا البسيط أو تصدير CRM خارجي) ويُرجع شكلاً موحّداً دائماً
 * (doctorRows + pharmacyRows) بصرف النظر عن الصيغة.
 */
export async function extractVisitsFromExcel(file, user) {
  const workbook = XLSX.readFile(file.path);
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  fs.unlink(file.path, () => {});

  const EMPTY = {
    doctorRows: [], pharmacyRows: [],
    repNames: { pending: [], resolved: [], unrelated: [], reps: [] },
    doctorNames: { pending: [], resolved: [], unrelated: [] },
    format: 'template', columnsDetected: {},
  };
  if (rows.length === 0) return EMPTY;

  const headers = Object.keys(rows[0]);
  const isCrm = detectCrmFormat(headers);
  const ownerUserId = await resolveDocOwnerUserId(user.id);

  // استخراج أسماء المندوبين حسب الصيغة (قبل التصنيف) — مشترك بين قائمتي
  // الأطباء والصيدليات لأنه نفس عمود المندوب في الملف نفسه.
  let colMap = {};
  let rawRepNames = [];
  if (isCrm) {
    const taskToCol = findCol(headers, ['task-to']);
    rawRepNames = taskToCol
      ? [...new Set(rows.map(r => leadingSegment(r[taskToCol])).filter(Boolean))]
      : [];
  } else {
    for (const [field, kws] of Object.entries(COL_KEYWORDS)) colMap[field] = findCol(headers, kws);
    rawRepNames = colMap.repName
      ? [...new Set(rows.map(r => String(r[colMap.repName] ?? '').trim()).filter(Boolean))]
      : [];
  }

  const repClassification = await classifyRepNamesForUser(rawRepNames, user);
  const repByKey = new Map();
  for (const e of [...repClassification.pending, ...repClassification.resolved]) {
    if (e.rep) repByKey.set(e.key, e.rep);
  }

  const [allAreas, allItems] = await Promise.all([
    prisma.area.findMany({ select: { id: true, name: true } }),
    prisma.item.findMany({ where: { userId: ownerUserId }, select: { id: true, name: true } }),
  ]);

  if (isCrm) {
    const { doctorRows, pharmacyRows } = extractCrmRows({ rows, headers, repByKey, allAreas, allItems });
    const { doctorNames } = await classifyDoctorRows(doctorRows, ownerUserId);
    return { doctorRows, pharmacyRows, repNames: repClassification, doctorNames, format: 'crm', columnsDetected: {} };
  }

  const doctorRows = rows.map((row, i) => {
    const get = field => (colMap[field] ? String(row[colMap[field]] ?? '').trim() : '');

    const repRaw = get('repName');
    const repKey = repRaw ? normalizeRepName(repRaw) : '';
    const rep = repKey ? repByKey.get(repKey) : null;

    const doctorName = get('doctor');
    const areaName   = get('area');
    const area = findByName(allAreas, areaName);

    const itemName = get('item');
    const item = findByName(allItems, itemName);
    const { lat, lng } = parseLocation(row, colMap);
    const dateVal = parseVisitDate(get('date'));

    return {
      _row: i + 2, // رقم صف الإكسل (1 = الترويسة)
      repName: repRaw, repId: rep?.id ?? null,
      doctorName, doctorId: null,
      specialty: get('specialty'),
      areaName, areaId: area?.id ?? null,
      pharmacyName: get('pharmacy'),
      itemName, itemId: item?.id ?? null,
      date: toDateInput(dateVal) || '',
      feedback: mapFeedback(get('feedback')),
      notes: get('notes'), isDoubleVisit: false,
      lat, lng,
    };
  }).filter(r => r.doctorName); // صف بلا اسم طبيب لا معنى لاستيراده كزيارة

  const { doctorNames } = await classifyDoctorRows(doctorRows, ownerUserId);
  return { doctorRows, pharmacyRows: [], repNames: repClassification, doctorNames, format: 'template', columnsDetected: colMap };
}

// ════════════════════════════════════════════════════════════════════════════
// COMMIT
// ════════════════════════════════════════════════════════════════════════════

/**
 * يحفظ صفوف زيارات الأطباء بعد مراجعة/تصحيح المستخدم: يُنشئ Doctor الناقص
 * (بنفس منطق تسجيل الزيارة اليدوي — إكمال الحقول الفارغة فقط لا استبدال
 * الموجود)، ثم DoctorVisit. صف بلا مندوب مؤكَّد (repId) يُتجاهل ويُذكر في
 * الأخطاء — لا نخمّن مندوباً.
 *
 * ⚠️ شاشة «الزيارات» لا تُبنى من DoctorVisit مباشرة — تُبنى من أطباء السيرفي
 * النشط ضمن نطاق المناطق (getScopedSurveyDoctors في surveyDoctors.js)، وتُلحق
 * بها الزيارات إن وُجدت (عبر masterSurveyDoctorId أو الاسم كبديل). فـDoctor
 * بلا ربط سيرفي (masterSurveyDoctorId=null) قد تُنشأ زيارته بنجاح في قاعدة
 * البيانات لكنها لن تظهر أبداً في تلك الشاشة. لذلك — تماماً كميزة «إضافة طبيب
 * جديد» الموجودة أصلاً (addCustomDoctor) — كل طبيب جديد هنا يُنشأ عبر السيرفي
 * أولاً (createSurveyDoctor) لا كصف Doctor مستقل.
 */
async function commitDoctorRows(rows, ownerUserId, user, importFileId) {
  const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
  const areaByNorm = new Map(allAreas.map(a => [normalizeAreaName(a.name), a]));
  // لحسم اسم الايتم نصاً إلى itemId: الاسم قد يكون مستخرجاً من حقل note أو
  // مكتوباً يدوياً في شبكة المراجعة، وDoctorVisit لا يخزّن إلا itemId.
  const allItems = await prisma.item.findMany({ where: { userId: ownerUserId }, select: { id: true, name: true } });

  // نفس السيرفي المضيف الذي تستعمله addCustomDoctor — أول سيرفي نشط ظاهر لهذا المالك.
  const hostSurvey = await prisma.masterSurvey.findFirst({
    where: {
      isActive: true,
      hiddenUsers: { none: { userId: ownerUserId } },
      ...(user?.officeId ? { hiddenOffices: { none: { officeId: user.officeId } } } : {}),
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  // أطباء السيرفي المتاحون لهذا المالك — لمطابقة طبيب موجود أصلاً بدل تكراره
  // كسجل سيرفي جديد منفصل بنفس الاسم.
  const visibleSurveys = await prisma.masterSurvey.findMany({
    where: { isActive: true, hiddenUsers: { none: { userId: ownerUserId } } },
    select: { id: true },
  });
  const surveyDoctorsAll = visibleSurveys.length
    ? await prisma.masterSurveyDoctor.findMany({
        where: { surveyId: { in: visibleSurveys.map(s => s.id) } },
        select: { id: true, name: true, areaName: true, specialty: true, pharmacyName: true },
      })
    : [];
  // عتبة تشابه مرتفعة عمداً (خطأ إملائي/مسافة بسيطة فقط) — هذا الربط تلقائي بلا
  // سؤال المستخدم (صف تجاوز مرحلة المطابقة التفاعلية بلا حسم — مثلاً تعديل يدوي
  // لاسم الطبيب في شبكة المراجعة)، فلا نخمّن عند أدنى التباس حقيقي؛ يبقى إنشاء
  // طبيب جديد أأمن من دمج شخصين مختلفين خطأً. يستعين بنفس محرك التطابق متعدد
  // الحقول (doctorMatchScore) المستخدم في المطابقة التفاعلية — الاسم أساساً،
  // والمنطقة/الاختصاص/الصيدلية ترجيحاً إضافياً.
  const FUZZY_THRESHOLD = 0.92;
  /** أفضل مرشّح من قائمة حسب doctorMatchScore، مع سياق الصف (منطقة/اختصاص/صيدلية) للترجيح. */
  const bestFuzzyMatch = (name, ctx, candidates, toFields) => {
    let best = null, bestScore = 0;
    for (const c of candidates) {
      const score = doctorMatchScore({ name, ...ctx }, toFields(c));
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore >= FUZZY_THRESHOLD ? { match: best, fuzzy: true } : { match: null, fuzzy: false };
  };

  const findSurveyDoctor = (name, ctx) => {
    const nameNorm = name.trim().toLowerCase();
    let cands = surveyDoctorsAll.filter(d => d.name.trim().toLowerCase() === nameNorm);
    if (cands.length === 0) return bestFuzzyMatch(name, ctx, surveyDoctorsAll, d => ({ name: d.name, areaName: d.areaName, specialty: d.specialty, pharmacyName: d.pharmacyName }));
    if (cands.length === 1) return { match: cands[0], fuzzy: false };
    const areaN = normalizeAreaName(ctx.areaName || '');
    return { match: cands.find(d => normalizeAreaName(d.areaName ?? '') === areaN) ?? cands[0], fuzzy: false };
  };

  // Doctor الموجودون أصلاً تحت هذا المالك — لتفادي إنشاء طبيب مكرّر لصف لاحق بنفس الاسم.
  const existingDoctors = await prisma.doctor.findMany({
    where: { userId: ownerUserId },
    select: { id: true, name: true, areaId: true, specialty: true, pharmacyName: true, masterSurveyDoctorId: true, area: { select: { name: true } } },
  });
  const findExistingDoctor = (name, areaIdLocal, ctx) => {
    const nameNorm = name.trim().toLowerCase();
    let cands = existingDoctors.filter(d => d.name.trim().toLowerCase() === nameNorm);
    if (cands.length === 0) return bestFuzzyMatch(name, ctx, existingDoctors, d => ({ name: d.name, areaName: d.area?.name ?? null, specialty: d.specialty, pharmacyName: d.pharmacyName }));
    if (areaIdLocal) return { match: cands.find(d => d.areaId === areaIdLocal) ?? cands[0], fuzzy: false };
    return { match: cands[0], fuzzy: false };
  };

  let imported = 0, skipped = 0;
  const errors = [];
  const doctorCache = new Map(); // "الاسم|areaId" → doctorId (يمنع تكرار الإنشاء لنفس الطبيب عبر صفوف الملف)
  let unlinkedNote = false;

  for (const r of (Array.isArray(rows) ? rows : [])) {
    try {
      const doctorName = String(r?.doctorName ?? '').trim();
      if (!doctorName) { skipped++; continue; }
      if (!r?.repId) { skipped++; errors.push(`طبيب — صف ${r?._row ?? '?'}: بلا مندوب مؤكَّد (${r?.repName || doctorName})`); continue; }

      let areaId = r.areaId ?? null;
      const areaName = String(r?.areaName ?? '').trim();
      if (!areaId && areaName) {
        const norm = normalizeAreaName(areaName);
        let found = areaByNorm.get(norm);
        if (!found) {
          found = await prisma.area.create({ data: { name: areaName, userId: ownerUserId } });
          areaByNorm.set(normalizeAreaName(found.name), found);
        }
        areaId = found.id;
      }

      let doctorId = r.doctorId ?? null;
      const cacheKey = `${doctorName.toLowerCase()}|${areaId ?? ''}`;
      if (!doctorId) doctorId = doctorCache.get(cacheKey) ?? null;

      const ctx = { areaName: areaName || null, specialty: r.specialty || '', pharmacyName: r.pharmacyName || '' };

      /**
       * يربط طبيباً موجوداً أصلاً بسجل سيرفي إن لم يكن مربوطاً (بلا هذا الربط لن
       * تظهر زياراته في شاشة «الزيارات»).
       *
       * قاعدة صارمة: اسم الطبيب في التطبيق لا يتغيّر أبداً بسبب ملف مستورد —
       * الاسم القادم من الملف مفتاح بحث/مطابقة فقط. لذلك يُنشأ سجل السيرفي (عند
       * الحاجة) باسم الطبيب كما هو مسجَّل في التطبيق، لا بالتهجئة القادمة من
       * الملف؛ وباقي الحقول (منطقة/اختصاص/صيدلية) تُؤخذ من التطبيق أولاً ولا
       * يُستعان بالملف إلا حين تكون فارغة عندنا.
       */
      const ensureSurveyLink = async (doc) => {
        if (!doc || doc.masterSurveyDoctorId) return;
        const appName = String(doc.name || '').trim() || doctorName;
        const appCtx = {
          areaName:     doc.area?.name   || areaName        || null,
          specialty:    doc.specialty    || r.specialty     || '',
          pharmacyName: doc.pharmacyName || r.pharmacyName  || '',
        };
        let sd = findSurveyDoctor(appName, appCtx).match;
        if (!sd && hostSurvey) {
          sd = await createSurveyDoctor(hostSurvey.id, {
            name: appName, specialty: appCtx.specialty || null,
            areaName: appCtx.areaName, pharmacyName: appCtx.pharmacyName || null,
          }, ownerUserId);
          if (sd) surveyDoctorsAll.push({
            id: sd.id, name: appName, areaName: appCtx.areaName,
            specialty: appCtx.specialty || null, pharmacyName: appCtx.pharmacyName || null,
          });
        }
        if (sd) {
          await prisma.doctor.update({ where: { id: doc.id }, data: { masterSurveyDoctorId: sd.id } });
          doc.masterSurveyDoctorId = sd.id;
        } else {
          unlinkedNote = true;
        }
      };

      if (!doctorId) {
        const { match: matchedDoctor, fuzzy: matchedByFuzzy } = findExistingDoctor(doctorName, areaId, ctx);

        if (matchedDoctor) {
          doctorId = matchedDoctor.id;
          // مطابقة تشابه لا تطابق تام — لم يُتَح للمستخدم تأكيدها تفاعلياً (مثلاً
          // اسم عُدِّل يدوياً في شبكة المراجعة بعد مرحلة المطابقة) → تُحفظ كرابط
          // بحاجة مراجعة عند السوبر أدمن، وتُعتمد تلقائياً لملفات لاحقة بنفس الاسم.
          if (matchedByFuzzy) {
            await prisma.doctorNameLink.upsert({
              where:  { userId_fromKey: { userId: ownerUserId, fromKey: doctorLinkKey(doctorName, areaName) } },
              update: {},
              create: {
                userId: ownerUserId, fromKey: doctorLinkKey(doctorName, areaName), fromName: doctorName,
                areaName: areaName || null, doctorId, confidence: 'fuzzy', needsReview: true,
              },
            });
          }
          // موجود لكن غير مربوط بأي سيرفي بعد — اربطه بدل تركه يتيماً (لن يظهر
          // في شاشة الزيارات بلا هذا الربط)، مع الإبقاء على اسمه في التطبيق كما هو.
          await ensureSurveyLink(matchedDoctor);
        } else {
          // طبيب جديد بالكامل — يُنشأ عبر السيرفي أولاً كي يظهر في الزيارات/
          // الأطباء/الأرشيف، ثم صف Doctor المربوط به (نفس نمط addCustomDoctor).
          const sd = findSurveyDoctor(doctorName, ctx).match ?? (hostSurvey
            ? await createSurveyDoctor(hostSurvey.id, {
                name: doctorName, specialty: r.specialty || null,
                areaName: areaName || null, pharmacyName: r.pharmacyName || null,
              }, ownerUserId)
            : null);
          if (!sd) unlinkedNote = true;

          const created = await prisma.doctor.create({
            data: {
              name: doctorName,
              specialty: r.specialty || null,
              pharmacyName: r.pharmacyName || null,
              areaId,
              userId: ownerUserId,
              masterSurveyDoctorId: sd?.id ?? null,
            },
          });
          doctorId = created.id;
          existingDoctors.push({
            id: created.id, name: doctorName, areaId,
            specialty: r.specialty || null, pharmacyName: r.pharmacyName || null,
            masterSurveyDoctorId: sd?.id ?? null, area: areaName ? { name: areaName } : null,
          });
          if (sd) surveyDoctorsAll.push({ id: sd.id, name: doctorName, areaName, specialty: r.specialty || null, pharmacyName: r.pharmacyName || null });
        }
        doctorCache.set(cacheKey, doctorId);
      } else {
        // طبيب محسوم مسبقاً (مطابقة أكّدها المستخدم، أو رابط اسم محفوظ، أو صف
        // سابق في الملف نفسه) — اسمه في التطبيق يبقى كما هو حرفياً؛ الملف يُضيف
        // زيارة فقط، ولا يُملأ من حقوله إلا ما كان فارغاً عندنا أصلاً.
        let doc = existingDoctors.find(d => d.id === doctorId);
        if (!doc) {
          const fetched = await prisma.doctor.findUnique({
            where: { id: doctorId },
            select: { id: true, name: true, areaId: true, specialty: true, pharmacyName: true, masterSurveyDoctorId: true, area: { select: { name: true } } },
          });
          if (fetched) { doc = fetched; existingDoctors.push(fetched); }
        }
        if (doc) {
          await ensureSurveyLink(doc);
          const upd = {};
          if (!doc.specialty    && r.specialty)    upd.specialty    = r.specialty;
          if (!doc.pharmacyName && r.pharmacyName) upd.pharmacyName = r.pharmacyName;
          if (!doc.areaId       && areaId)         upd.areaId       = areaId;
          if (Object.keys(upd).length) {
            await prisma.doctor.update({ where: { id: doc.id }, data: upd });
            Object.assign(doc, upd);
          }
        }
      }

      const dateVal = parseVisitDate(r.date);
      await prisma.doctorVisit.create({
        data: {
          doctorId,
          scientificRepId: r.repId,
          visitDate: dateVal ?? new Date(),
          itemId: r.itemId ?? (r.itemName ? matchItemByText(allItems, r.itemName)?.id ?? null : null),
          feedback: r.feedback || 'pending',
          notes: r.notes ? String(r.notes) : null,
          isDoubleVisit: !!r.isDoubleVisit,
          latitude:  Number.isFinite(r.lat) ? r.lat : null,
          longitude: Number.isFinite(r.lng) ? r.lng : null,
          userId: user.id,
          visitImportFileId: importFileId ?? null,
        },
      });
      imported++;
    } catch (e) {
      skipped++;
      errors.push(`طبيب — صف ${r?._row ?? '?'}: ${e.message}`);
    }
  }

  if (unlinkedNote) {
    errors.push('تنبيه: لا توجد قائمة سيرفي متاحة لهذا الحساب — بعض الأطباء الجدد أُنشئوا بلا ربط بالسيرفي ولن يظهروا في شاشة «الزيارات» حتى تُربط لاحقاً.');
  }

  return { imported, skipped, errors };
}

/** نفس منطق commitDoctorRows لكن لِـ PharmacyVisit — pharmacyName نص حر بلا سجل رئيسي فيُحفظ كما هو. */
async function commitPharmacyRows(rows, ownerUserId, user, importFileId) {
  const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
  const areaByNorm = new Map(allAreas.map(a => [normalizeAreaName(a.name), a]));
  const allItems = await prisma.item.findMany({ where: { userId: ownerUserId }, select: { id: true, name: true } });

  let imported = 0, skipped = 0;
  const errors = [];

  for (const r of (Array.isArray(rows) ? rows : [])) {
    try {
      const pharmacyName = String(r?.pharmacyName ?? '').trim();
      if (!pharmacyName) { skipped++; continue; }
      if (!r?.repId) { skipped++; errors.push(`صيدلية — صف ${r?._row ?? '?'}: بلا مندوب مؤكَّد (${r?.repName || pharmacyName})`); continue; }

      let areaId = r.areaId ?? null;
      const areaName = String(r?.areaName ?? '').trim();
      if (!areaId && areaName) {
        const norm = normalizeAreaName(areaName);
        let found = areaByNorm.get(norm);
        if (!found) {
          found = await prisma.area.create({ data: { name: areaName, userId: ownerUserId } });
          areaByNorm.set(normalizeAreaName(found.name), found);
        }
        areaId = found.id;
      }

      const dateVal = parseVisitDate(r.date);
      const visit = await prisma.pharmacyVisit.create({
        data: {
          pharmacyName,
          areaId,
          areaName: areaId ? null : (areaName || null),
          scientificRepId: r.repId,
          visitDate: dateVal ?? new Date(),
          notes: r.notes ? String(r.notes) : null,
          isDoubleVisit: !!r.isDoubleVisit,
          latitude:  Number.isFinite(r.lat) ? r.lat : null,
          longitude: Number.isFinite(r.lng) ? r.lng : null,
          userId: user.id,
          visitImportFileId: importFileId ?? null,
        },
      });
      // الايتم المستخرج من حقل note — PharmacyVisitItem يقبل itemId أو اسماً حراً،
      // فلا يُفقَد الايتم حتى لو لم يكن في كتالوج الحساب.
      const itemName = String(r?.itemName ?? '').trim();
      const itemId = r?.itemId ?? (itemName ? matchItemByText(allItems, itemName)?.id ?? null : null);
      if (itemId || itemName) {
        await prisma.pharmacyVisitItem.create({
          data: {
            pharmacyVisitId: visit.id,
            itemId,
            itemName: itemId ? null : itemName,
          },
        });
      }
      imported++;
    } catch (e) {
      skipped++;
      errors.push(`صيدلية — صف ${r?._row ?? '?'}: ${e.message}`);
    }
  }

  return { imported, skipped, errors };
}

/**
 * نقطة الحفظ الموحّدة: تحفظ روابط أسماء المندوبين وأسماء الأطباء المؤكَّدة أولاً
 * (تُستعمل فوراً + تُطبَّق تلقائياً في الاستيرادات القادمة)، تُنشئ سجل
 * VisitImportFile واحداً لهذا الملف (يتيح لاحقاً تعطيل/حذف كل زياراته دفعة
 * واحدة من "الملفات المرفوعة")، ثم تستورد صفوف الأطباء والصيدليات معاً
 * (أي منهما قد يكون فارغاً حسب صيغة الملف) مربوطة به.
 */
export async function commitVisitsImport({ doctorRows = [], pharmacyRows = [], rememberRepLinks = [], rememberDoctorLinks = [], fileName = '', user }) {
  const ownerUserId = await resolveDocOwnerUserId(user.id);

  if (rememberRepLinks.length) await saveRepNameLinks(user.id, rememberRepLinks);
  if (rememberDoctorLinks.length) await saveDoctorNameLinks(ownerUserId, rememberDoctorLinks);

  const importFile = await prisma.visitImportFile.create({
    data: { originalName: fileName?.trim() || 'ملف بدون اسم', userId: user.id, ownerUserId },
  });

  const [doctorResult, pharmacyResult] = await Promise.all([
    commitDoctorRows(doctorRows, ownerUserId, user, importFile.id),
    commitPharmacyRows(pharmacyRows, ownerUserId, user, importFile.id),
  ]);

  const totalImported = doctorResult.imported + pharmacyResult.imported;
  // لا نُبقي سجل ملف فارغاً (كل الصفوف فشلت/تُجوهلت) — يُربك قائمة "الملفات المرفوعة".
  if (totalImported === 0) {
    await prisma.visitImportFile.delete({ where: { id: importFile.id } }).catch(() => {});
  }

  return {
    imported: totalImported,
    skipped:  doctorResult.skipped + pharmacyResult.skipped,
    errors:   [...doctorResult.errors, ...pharmacyResult.errors].slice(0, 30),
    doctor:   doctorResult,
    pharmacy: pharmacyResult,
  };
}
