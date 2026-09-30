// ════════════════════════════════════════════════════════════════════════════
// surveySync.js — محرّك دورة تحديث السيرفي عبر إكسل مُرمَّز
// ────────────────────────────────────────────────────────────────────────────
// تصدير ملف يحمل رمزاً ثابتاً لكل صف ← المندوب يعدّل ← رفع ← مقارنة ← مراجعة
// السوبر أدمن ← تطبيق. محرّك واحد يخدم الأطباء والصيدليات معاً (entryType)
// لا نسختين، لأن كل الاختلاف بينهما قائمة حقول وثلاث دوال مكتبة.
//
// لماذا لا عمود «رمز» جديد في قاعدة البيانات:
//   MasterSurveyDoctor.id و MasterSurveyPharmacy.id أرقام تسلسلية دائمة وفريدة
//   عالمياً أصلاً، ومع اعتماد التعطيل بدل الحذف لا تتغيّر أبداً. فالرمز مشتق
//   للعرض فقط (D-000123 / P-000456) بلا عمود ولا ترحيل ولا خطر تضارب. ولأن
//   parseSurveyCode متسامح، يمكن إضافة عمود code حقيقي لاحقاً بلا كسر أي ملف
//   سبق تصديره.
// ════════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import prisma from './prisma.js';
import { normalizeAreaName } from './itemResolver.js';
import {
  createSurveyDoctor, updateSurveyDoctor, deactivateSurveyDoctor,
  classifySurveyDoctorRows, saveSurveyDoctorAlias,
} from './surveyDoctors.js';
import {
  createSurveyPharmacy, updateSurveyPharmacy, deactivateSurveyPharmacy,
  classifySurveyPharmacyRows, saveSurveyPharmacyAlias,
  cascadePharmacyNameChange,
} from './surveyPharmacies.js';

// ── تعريف النوعين ───────────────────────────────────────────────────────────
// العناوين مطابقة حرفياً لنماذج الإكسل القائمة في MasterSurveyPage
// (downloadTemplate) كي يقرأ الملف المُصدَّر نفسُه بخرائط الأعمدة الموجودة
// أصلاً عند إعادة الرفع، بلا أي كشف أعمدة جديد.
export const SYNC_TYPES = {
  doctor: {
    prefix: 'D',
    sheetName: 'الأطباء',
    fileLabel: 'أطباء',
    fields: ['name', 'specialty', 'areaName', 'pharmacyName', 'className', 'zoneName', 'phone', 'notes'],
    headers: {
      name: 'اسم الطبيب', specialty: 'الاختصاص', areaName: 'المنطقة',
      pharmacyName: 'اسم الصيدلية', className: 'الكلاس', zoneName: 'الزون',
      phone: 'الهاتف', notes: 'ملاحظات',
    },
  },
  pharmacy: {
    prefix: 'P',
    sheetName: 'الصيدليات',
    fileLabel: 'صيدليات',
    fields: ['name', 'ownerName', 'pharmacyName', 'phone', 'address', 'areaName', 'notes'],
    headers: {
      name: 'اسم الصيدلية', ownerName: 'صاحب الصيدلية', pharmacyName: 'الفرع / السلسلة',
      phone: 'الهاتف', address: 'العنوان', areaName: 'المنطقة', notes: 'ملاحظات',
    },
  },
};

export const CODE_HEADER = 'الرمز';
export const ACTION_HEADER = 'الإجراء';
export const DELETE_ACTION_WORDS = ['حذف', 'حذفه', 'احذف', 'الغاء', 'إلغاء', 'delete', 'remove', 'del', 'x'];

export function isSyncType(t) { return t === 'doctor' || t === 'pharmacy'; }

// ── الرمز ───────────────────────────────────────────────────────────────────
export function formatSurveyCode(entryType, id) {
  const def = SYNC_TYPES[entryType];
  if (!def || !Number.isInteger(id) || id <= 0) return '';
  return `${def.prefix}-${String(id).padStart(6, '0')}`;
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';
function toAsciiDigits(s) {
  return String(s).replace(/[٠-٩۰-۹]/g, ch => {
    const i = ARABIC_INDIC.indexOf(ch);
    return String(i >= 0 ? i : EXTENDED_ARABIC_INDIC.indexOf(ch));
  });
}

// حرف البادئة المقبول لكل نوع — يشمل الحرف العربي لأن المندوب قد يعيد كتابة
// الرمز يدوياً بلوحة مفاتيح عربية بعد أن يمسح الخلية سهواً.
const PREFIX_LETTERS = { doctor: ['d', 'د', 'ط'], pharmacy: ['p', 'ص'] };

/**
 * يقرأ خلية «الرمز» بتسامح مقصود: D-000123 / d123 / ‎123‎ / د-١٢٣ / مع مسافات
 * أو علامات اتجاه أو فاصلة عليا يضيفها إكسل. أي شكل غير مفهوم يُعاد كـ
 * { ok:false } — ولا يُترجم أبداً إلى «صف جديد» صامت: الصف يذهب لمسار
 * المطابقة الضبابية ثم لمراجعة السوبر أدمن.
 */
export function parseSurveyCode(raw, entryType = null) {
  let s = String(raw ?? '');
  // علامات الاتجاه/الفراغات الصفرية التي تلتصق بالنص المنسوخ من إكسل
  s = s.replace(/[‎‏‪-‮⁦-⁩﻿']/g, '').trim();
  if (!s) return { ok: false, reason: 'empty' };

  s = toAsciiDigits(s);
  const m = s.match(/^([A-Za-z؀-ۿ]*)[\s._\-–—]*(\d{1,9})$/);
  if (!m) return { ok: false, reason: 'unparsable' };

  const letters = m[1].toLowerCase();
  const id = parseInt(m[2], 10);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'unparsable' };

  if (letters && entryType) {
    const allowed = PREFIX_LETTERS[entryType] ?? [];
    const other = entryType === 'doctor' ? PREFIX_LETTERS.pharmacy : PREFIX_LETTERS.doctor;
    // بادئة النوع الآخر = المندوب رفع ملف الصيدليات في خانة الأطباء أو العكس.
    // خطأ يستحق التوقف لا التخمين — الرقم نفسه صالح في الجدولين.
    if (other.includes(letters)) return { ok: false, reason: 'wrong_type' };
    if (!allowed.includes(letters)) return { ok: false, reason: 'unparsable' };
  }
  return { ok: true, id };
}

export function isDeleteAction(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return false;
  return DELETE_ACTION_WORDS.includes(s);
}

// ── تطبيع القيم والمقارنة ───────────────────────────────────────────────────
// قيمة مخزَّنة: فراغ/سلسلة فارغة ⇒ null، وتوحيد المسافات كي لا يُحسب فرق مسافة
// زائدة تعديلاً (المندوبون يضيفونها ويحذفونها بلا قصد طوال الوقت).
export function normalizeStored(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

// رمز المسح الصريح: خلية فارغة تعني «لم أذكر هذا الحقل» لا «امسحه». بلا هذا
// التمييز، أي عمود يحذفه المندوب من الملف أو يتركه فارغاً كان سيمسح بيانات
// موجودة فعلاً في السيرفي — أكبر مصدر لفقدان البيانات في دورات الإكسل.
const ERASE_TOKEN = '-';

/** يُعيد undefined إذا لم يُذكر الحقل، أو null للمسح الصريح، أو القيمة. */
export function readIncoming(field, raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (s === '') return undefined;
  if (s === ERASE_TOKEN) return field === 'name' ? undefined : null; // الاسم لا يُمسح
  return s;
}

function valuesEqual(field, a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (field === 'areaName') return normalizeAreaName(a) === normalizeAreaName(b);
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * بصمة صف السيرفي وقت التصدير. نحفظ البصمة لا القيم: ~25 بايت للصف بدل ~150،
 * وهي كل ما يلزم للسؤال الوحيد الذي تجيب عنه — «هل تغيّر هذا الصف منذ
 * التصدير؟». عرض القيم للسوبر أدمن يأتي من قاعدة البيانات لحظة الرفع.
 */
export function rowHash(entryType, row) {
  const def = SYNC_TYPES[entryType];
  if (!def) return '';
  const payload = def.fields.map(f => {
    const v = normalizeStored(row?.[f]);
    if (v == null) return '';
    return f === 'areaName' ? normalizeAreaName(v) : v.toLowerCase();
  }).join('\u001f');
  return crypto.createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, 8);
}

// ── التصدير ─────────────────────────────────────────────────────────────────
/** يبني صفوف الملف (بالرمز) + خريطة البصمات التي ستُحفظ في SurveyExport. */
export function buildExportPayload(entryType, records) {
  const def = SYNC_TYPES[entryType];
  if (!def) throw new Error(`entryType غير معروف: ${entryType}`);
  const rowHashes = {};
  const rows = records.map(r => {
    rowHashes[r.id] = rowHash(entryType, r);
    const out = { code: formatSurveyCode(entryType, r.id) };
    for (const f of def.fields) out[f] = normalizeStored(r[f]) ?? '';
    out.action = '';
    return out;
  });
  return { rows, rowHashes };
}

export function makeExportToken() {
  return crypto.randomBytes(9).toString('base64url'); // 12 حرفاً، آمن في اسم ملف وخلية
}

// ── المقارنة ────────────────────────────────────────────────────────────────
const CHANGE_TYPES = ['unchanged', 'update', 'move', 'new', 'delete', 'conflict', 'unmatched'];
export function emptyCounts() {
  return Object.fromEntries(CHANGE_TYPES.map(t => [t, 0]));
}

/**
 * يصنّف صفوف ملف مرفوع مقابل الحالة الراهنة للسيرفي + بصمات وقت التصدير.
 * قراءة فقط — لا يكتب شيئاً.
 *
 * القواعد الحاكمة (كلها في خدمة «لا تفقد أي بيانات»):
 *  • صف غائب عن الملف لا يُنتج حذفاً أبداً — الغياب ملتبس مع «لم أراجعه».
 *    الحذف يُطلب حصراً بكلمة «حذف» في عمود الإجراء.
 *  • رمز مفقود أو مشوَّه أو يشير خارج هذا السيرفي ⇒ unmatched مع مرشّحين،
 *    لا إنشاء صامت ولا استبدال.
 *  • خلية فارغة ⇒ «لم يُذكر»، لا تمسح قيمة قائمة. المسح الصريح بـ «-».
 *  • تغيّرت قيمة الصف في قاعدة البيانات منذ التصدير ⇒ conflict يُعرض بطرفيه،
 *    بدل دهس تعديل زميل أحدث بصمت.
 */
// currentRows / classifier قابلان للحقن: الاختبار يمرّرهما فيعمل المحرّك كاملاً
// بلا قاعدة بيانات — وهذه دالة يجب أن تكون مغطّاة باختبار، إذ خطأ تصنيف واحد
// فيها يساوي فقدان بيانات ميدانية.
export async function diffSurveyRows({ entryType, surveyId, incomingRows, baselineHashes = {}, currentRows = null, classifier = null }) {
  const def = SYNC_TYPES[entryType];
  if (!def) throw new Error(`entryType غير معروف: ${entryType}`);

  if (!currentRows) {
    const model = entryType === 'doctor' ? prisma.masterSurveyDoctor : prisma.masterSurveyPharmacy;
    const select = { id: true, isActive: true };
    for (const f of def.fields) select[f] = true;
    currentRows = await model.findMany({ where: { surveyId }, select });
  }
  const currentById = new Map(currentRows.map(r => [r.id, r]));

  const results = [];
  const needsFuzzy = []; // صفوف بلا رمز صالح — تمرّ على المطابق الضبابي دفعةً

  incomingRows.forEach((raw, idx) => {
    const rowNumber = Number(raw?.__row) || (idx + 2); // +2: صف العناوين ثم أساس 1
    const incoming = {};
    for (const f of def.fields) {
      const v = readIncoming(f, raw?.[f]);
      if (v !== undefined) incoming[f] = v;
    }
    const nameGiven = normalizeStored(incoming.name);
    const wantsDelete = isDeleteAction(raw?.action);
    const parsed = parseSurveyCode(raw?.code, entryType);

    const base = { rowNumber, incoming, wantsDelete };

    if (!parsed.ok) {
      // بلا اسم وبلا رمز = صف فارغ تماماً (ذيل الورقة) — يُتجاهل بلا ضجيج.
      if (!nameGiven) return;
      needsFuzzy.push({ ...base, codeIssue: parsed.reason });
      return;
    }

    const current = currentById.get(parsed.id);
    if (!current) {
      // الرمز سليم الشكل لكنه لا يخصّ هذا السيرفي: ملف سيرفي آخر، أو صف
      // حُذف فعلياً قبل اعتماد التعطيل. لا يُنشأ ولا يُخمَّن.
      if (!nameGiven) return;
      needsFuzzy.push({ ...base, codeIssue: 'not_in_survey', claimedId: parsed.id });
      return;
    }

    if (wantsDelete) {
      results.push({ ...base, entryId: current.id, current, changeType: current.isActive ? 'delete' : 'unchanged', diffs: [] });
      return;
    }

    const diffs = [];
    for (const f of def.fields) {
      if (incoming[f] === undefined) continue;
      const from = normalizeStored(current[f]);
      const to = incoming[f] === null ? null : normalizeStored(incoming[f]);
      if (!valuesEqual(f, from, to)) diffs.push({ field: f, from, to });
    }

    if (diffs.length === 0) {
      results.push({ ...base, entryId: current.id, current, changeType: 'unchanged', diffs: [] });
      return;
    }

    // كشف التعارض: البصمة المحفوظة وقت التصدير مقابل بصمة الصف الآن.
    const baseHash = baselineHashes?.[String(current.id)];
    if (baseHash && rowHash(entryType, current) !== baseHash) {
      results.push({ ...base, entryId: current.id, current, changeType: 'conflict', diffs });
      return;
    }

    const areaChanged = diffs.some(d => d.field === 'areaName');
    const changeType = (areaChanged && diffs.length === 1) ? 'move' : 'update';
    results.push({ ...base, entryId: current.id, current, changeType, diffs });
  });

  // ── الصفوف بلا رمز صالح: المطابق الضبابي القائم (لا محرّك ثانٍ) ──
  if (needsFuzzy.length) {
    const classify = classifier ?? (entryType === 'doctor' ? classifySurveyDoctorRows : classifySurveyPharmacyRows);
    const probe = needsFuzzy.map(r => ({ ...r.incoming }));
    const cls = await classify(surveyId, probe);
    const matchKey = entryType === 'doctor' ? 'matchedDoctorId' : 'matchedPharmacyId';
    const suggestionsByKey = new Map();
    for (const p of cls.pending) suggestionsByKey.set(p.key, p.suggestions);

    needsFuzzy.forEach((r, i) => {
      const probed = probe[i];
      const matchedId = probed?.[matchKey] ?? null;
      const suggestions = suggestionsByKey.get(probed?.rowKey) ?? [];

      if (matchedId && currentById.has(matchedId)) {
        // ذاكرة مطابقة مؤكَّدة أو تطابق تام: نعامله كصف معروف الهوية ونعيد
        // حساب الفروق ضده — أفضل من إنشاء نسخة ثانية للطبيب/الصيدلية نفسها.
        const current = currentById.get(matchedId);
        if (r.wantsDelete) {
          results.push({ ...r, entryId: current.id, current, changeType: current.isActive ? 'delete' : 'unchanged', diffs: [] });
          return;
        }
        const diffs = [];
        for (const f of def.fields) {
          if (r.incoming[f] === undefined) continue;
          const from = normalizeStored(current[f]);
          const to = r.incoming[f] === null ? null : normalizeStored(r.incoming[f]);
          if (!valuesEqual(f, from, to)) diffs.push({ field: f, from, to });
        }
        const areaChanged = diffs.some(d => d.field === 'areaName');
        const changeType = diffs.length === 0 ? 'unchanged'
          : (areaChanged && diffs.length === 1) ? 'move' : 'update';
        results.push({ ...r, entryId: current.id, current, changeType, diffs });
        return;
      }

      if (suggestions.length) {
        results.push({ ...r, entryId: null, current: null, changeType: 'unmatched', diffs: [], candidates: suggestions });
        return;
      }

      // طلب حذف لصف لا نعرف هويته لا يُنفَّذ ولا يُنشئ صفاً جديداً.
      if (r.wantsDelete) {
        results.push({ ...r, entryId: null, current: null, changeType: 'unmatched', diffs: [], candidates: [] });
        return;
      }

      // الإنشاء الصامت مسموح **فقط** لصف تُرك رمزه فارغاً — وهذه هي الطريقة
      // الموثَّقة لإضافة اسم جديد. أما رمز مكتوب لكنه مشوَّه، أو من نوع آخر،
      // أو يشير خارج هذا السيرفي، فهو إشارة خلل لا إذن إنشاء: قد يكون المندوب
      // رفع ملف سيرفي آخر، أو أفسد العمود بالسحب في إكسل. إنشاء صفوف جديدة
      // عندها يُغرق السيرفي بنسخ مكرّرة لا يلاحظها أحد إلا بعد فوات الأوان.
      if (r.codeIssue && r.codeIssue !== 'empty') {
        results.push({ ...r, entryId: null, current: null, changeType: 'unmatched', diffs: [], candidates: [] });
        return;
      }
      results.push({ ...r, entryId: null, current: null, changeType: 'new', diffs: [] });
    });
  }

  results.sort((a, b) => a.rowNumber - b.rowNumber);
  const counts = emptyCounts();
  for (const r of results) counts[r.changeType]++;
  return { rows: results, counts };
}

// ── التطبيق ─────────────────────────────────────────────────────────────────
// يُستدعى فقط للصفوف المعتمَدة. كل مسار يمرّ عبر دوال المكتبتين لا عبر prisma
// مباشرة، فيُكتب MasterSurveyEditLog ويُنفَّذ الـ cascade تلقائياً — وهو أيضاً
// سبب ظهور هذه التغييرات فوراً في شاشة 🔔 «سجل الأطباء» (تشترط editedById غير
// فارغ، أي أن رافع الملف هو من يُنسب إليه التغيير لا السوبر أدمن المعتمِد).
export async function applySyncRow(entryType, surveyId, row, editedById, areaCache = null) {
  const def = SYNC_TYPES[entryType];
  const fields = {};
  for (const f of def.fields) {
    if (row.incoming[f] !== undefined) fields[f] = row.incoming[f];
  }

  if (row.changeType === 'delete') {
    return entryType === 'doctor'
      ? deactivateSurveyDoctor(surveyId, row.entryId, editedById)
      : deactivateSurveyPharmacy(surveyId, row.entryId, editedById);
  }

  if (row.changeType === 'new') {
    if (!normalizeStored(fields.name)) return { error: 'empty_name' };
    return entryType === 'doctor'
      ? createSurveyDoctor(surveyId, fields, editedById, areaCache)
      : createSurveyPharmacy(surveyId, fields, editedById, areaCache);
  }

  // update / move / conflict-resolved-to-incoming
  if (!row.entryId) return { error: 'no_target' };
  return entryType === 'doctor'
    ? updateSurveyDoctor(surveyId, row.entryId, fields, editedById, areaCache)
    : updateSurveyPharmacy(surveyId, row.entryId, fields, editedById, areaCache);
}

/**
 * يحفظ قرار السوبر أدمن على صف unmatched كي لا يُعاد السؤال عن نفس الاسم في
 * الرفعة القادمة — targetId فارغ يعني «ليس أياً من الموجودين» ويُحفظ أيضاً.
 */
export function rememberSyncDecision(entryType, surveyId, { fromName, areaName, targetId, createdById }) {
  return entryType === 'doctor'
    ? saveSurveyDoctorAlias(surveyId, { fromName, areaName, surveyDoctorId: targetId ?? null, createdById })
    : saveSurveyPharmacyAlias(surveyId, { fromName, areaName, surveyPharmacyId: targetId ?? null, createdById });
}

/**
 * الأثر الجانبي لإعادة تسمية صيدلية، محسوباً قبل التطبيق كي يظهر في شاشة
 * المراجعة: «سيتبع الاسمَ الجديد ١٢ طبيباً و٣٤٠ زيارة». عند الأطباء الأثر
 * محسوم بالـ FK فلا حاجة لحسابه.
 */
export async function previewPharmacyRenameImpact(surveyId, row) {
  if (!row?.current) return null;
  const rename = (row.diffs || []).find(d => d.field === 'name');
  if (!rename) return null;
  return cascadePharmacyNameChange(surveyId, [rename.from], rename.to, {
    areaNames: [row.current.areaName, row.incoming.areaName].filter(Boolean),
    dryRun: true,
  });
}
