/**
 * استيراد زيارات الأطباء بالجملة من ملف إكسل خارجي — بديل عن تسجيلها يدوياً
 * واحدة تلو الأخرى من داخل التطبيق. كل صف = زيارة واحدة (طبيب + تاريخ + فيدباك).
 *
 * تدفّق العمل على مرحلتين (مطابق لنمط ManualSalesModal):
 *   1) extractVisitsFromExcel — يقرأ الملف، يحاول مطابقة كل حقل تلقائياً
 *      (المندوب/الطبيب/المنطقة/الايتم)، ويُعيد الصفوف للمراجعة — لا يُنشئ شيئاً.
 *   2) commitVisitsImport — يأخذ الصفوف بعد مراجعة المستخدم وتصحيحها، وينشئ
 *      صفوف Doctor الناقصة + DoctorVisit فعلياً.
 *
 * مطابقة اسم المندوب تُعاد استعمالها من محرّك ميركاتو (classifyRepNamesForUser)
 * عمداً: نفس السؤال بالضبط ("هل هذا الاسم الحر هو المندوب فلان؟")، وأي رابط
 * يؤكّده المستخدم هنا يُطبَّق تلقائياً لاحقاً في ميركاتو والعكس صحيح.
 */

import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';
import fs from 'fs';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import { resolveDocOwnerUserId } from './doctors.controller.js';
import { classifyRepNamesForUser, normalizeRepName } from '../scientific-reps/scientific-reps.service.js';

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

function parseVisitDate(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') { // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (dmy) { const d = new Date(+dmy[3], +dmy[2] - 1, +dmy[1]); if (!isNaN(d.getTime())) return d; }
  const ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (ymd) { const d = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]); if (!isNaN(d.getTime())) return d; }
  const generic = new Date(s);
  return isNaN(generic.getTime()) ? null : generic;
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

/**
 * قراءة الملف ومحاولة مطابقة كل حقل — بلا إنشاء أي شيء. النتيجة صفوف تُعرض
 * لمراجعة المستخدم في شبكة قابلة للتعديل قبل الحفظ الفعلي.
 */
export async function extractVisitsFromExcel(file, user) {
  const workbook = XLSX.readFile(file.path);
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  fs.unlink(file.path, () => {});

  if (rows.length === 0) {
    return { rows: [], repNames: { pending: [], resolved: [], unrelated: [], reps: [] }, columnsDetected: {} };
  }

  const headers = Object.keys(rows[0]);
  const colMap  = {};
  for (const [field, kws] of Object.entries(COL_KEYWORDS)) colMap[field] = findCol(headers, kws);

  const ownerUserId = await resolveDocOwnerUserId(user.id);

  // مطابقة أسماء المندوبين — نفس محرك ميركاتو، والروابط المحفوظة مسبقاً (من
  // ميركاتو أو من استيراد سابق) تُطبَّق هنا تلقائياً.
  const rawRepNames = colMap.repName
    ? [...new Set(rows.map(r => String(r[colMap.repName] ?? '').trim()).filter(Boolean))]
    : [];
  const repClassification = await classifyRepNamesForUser(rawRepNames, user);
  const repByKey = new Map();
  for (const e of [...repClassification.pending, ...repClassification.resolved]) {
    if (e.rep) repByKey.set(e.key, e.rep);
  }

  const [allAreas, allItems, existingDoctors] = await Promise.all([
    prisma.area.findMany({ select: { id: true, name: true } }),
    prisma.item.findMany({ where: { userId: ownerUserId }, select: { id: true, name: true } }),
    prisma.doctor.findMany({ where: { userId: ownerUserId }, select: { id: true, name: true, areaId: true } }),
  ]);

  const outRows = rows.map((row, i) => {
    const get = field => (colMap[field] ? String(row[colMap[field]] ?? '').trim() : '');

    const repRaw = get('repName');
    const repKey = repRaw ? normalizeRepName(repRaw) : '';
    const rep = repKey ? repByKey.get(repKey) : null;

    const doctorName = get('doctor');
    const areaName   = get('area');
    const area = findByName(allAreas, areaName);

    const sameNameDoctors = doctorName
      ? existingDoctors.filter(d => d.name.trim().toLowerCase() === doctorName.toLowerCase())
      : [];
    const existingDoctor = area
      ? (sameNameDoctors.find(d => d.areaId === area.id) ?? sameNameDoctors[0] ?? null)
      : (sameNameDoctors[0] ?? null);

    const itemName = get('item');
    const item = findByName(allItems, itemName);
    const { lat, lng } = parseLocation(row, colMap);
    const dateVal = parseVisitDate(get('date'));

    return {
      _row: i + 2, // رقم صف الإكسل (1 = الترويسة)
      repName: repRaw, repId: rep?.id ?? null,
      doctorName, doctorId: existingDoctor?.id ?? null,
      specialty: get('specialty'),
      areaName, areaId: area?.id ?? null,
      pharmacyName: get('pharmacy'),
      itemName, itemId: item?.id ?? null,
      date: dateVal ? dateVal.toISOString().slice(0, 10) : '',
      feedback: mapFeedback(get('feedback')),
      notes: get('notes'),
      lat, lng,
    };
  }).filter(r => r.doctorName); // صف بلا اسم طبيب لا معنى لاستيراده كزيارة

  return { rows: outRows, repNames: repClassification, columnsDetected: colMap };
}

/**
 * يحفظ الصفوف بعد مراجعة/تصحيح المستخدم: يُنشئ Doctor الناقص (بنفس منطق تسجيل
 * الزيارة اليدوي — إكمال الحقول الفارغة فقط لا استبدال الموجود)، ثم DoctorVisit.
 * صف بلا مندوب مؤكَّد (repId) يُتجاهل ويُذكر في الأخطاء — لا نخمّن مندوباً.
 */
export async function commitVisitsImport({ rows, rememberRepLinks = [], user }) {
  const ownerUserId = await resolveDocOwnerUserId(user.id);

  if (rememberRepLinks.length) {
    for (const l of rememberRepLinks) {
      const fromName = String(l?.fromName ?? '').trim();
      const fromKey  = normalizeRepName(fromName);
      if (!fromKey) continue;
      await prisma.sciRepNameLink.upsert({
        where:  { userId_fromKey: { userId: user.id, fromKey } },
        update: { fromName, scientificRepId: l?.scientificRepId ?? null },
        create: { userId: user.id, fromKey, fromName, scientificRepId: l?.scientificRepId ?? null },
      });
    }
  }

  const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
  const areaByNorm = new Map(allAreas.map(a => [normalizeAreaName(a.name), a]));

  let imported = 0, skipped = 0;
  const errors = [];
  const doctorCache = new Map(); // "الاسم|areaId" → doctorId (يمنع تكرار الإنشاء لنفس الطبيب عبر صفوف الملف)

  for (const r of (Array.isArray(rows) ? rows : [])) {
    try {
      const doctorName = String(r?.doctorName ?? '').trim();
      if (!doctorName) { skipped++; continue; }
      if (!r?.repId) { skipped++; errors.push(`صف ${r?._row ?? '?'}: بلا مندوب مؤكَّد (${r?.repName || doctorName})`); continue; }

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

      if (!doctorId) {
        const created = await prisma.doctor.create({
          data: {
            name: doctorName,
            specialty: r.specialty || null,
            pharmacyName: r.pharmacyName || null,
            areaId,
            userId: ownerUserId,
          },
        });
        doctorId = created.id;
        doctorCache.set(cacheKey, doctorId);
      } else if (r.specialty || r.pharmacyName || areaId) {
        const doc = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { specialty: true, pharmacyName: true, areaId: true } });
        if (doc) {
          const upd = {};
          if (!doc.specialty    && r.specialty)    upd.specialty    = r.specialty;
          if (!doc.pharmacyName && r.pharmacyName) upd.pharmacyName = r.pharmacyName;
          if (!doc.areaId       && areaId)         upd.areaId       = areaId;
          if (Object.keys(upd).length) await prisma.doctor.update({ where: { id: doctorId }, data: upd });
        }
      }

      const dateVal = parseVisitDate(r.date);
      await prisma.doctorVisit.create({
        data: {
          doctorId,
          scientificRepId: r.repId,
          visitDate: dateVal ?? new Date(),
          itemId: r.itemId ?? null,
          feedback: r.feedback || 'pending',
          notes: r.notes ? String(r.notes) : null,
          latitude:  Number.isFinite(r.lat) ? r.lat : null,
          longitude: Number.isFinite(r.lng) ? r.lng : null,
          userId: user.id,
        },
      });
      imported++;
    } catch (e) {
      skipped++;
      errors.push(`صف ${r?._row ?? '?'}: ${e.message}`);
    }
  }

  return { imported, skipped, errors: errors.slice(0, 30) };
}
