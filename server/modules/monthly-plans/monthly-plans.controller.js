import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Helper: find a plan the user has access to ──────────────
// - owner (admin/manager): plans where userId = myId
// - assigned user (rep):   plans where assignedUserId = myId
async function findAccessiblePlan(planId, userId, role) {
  const where = role === 'user'
    ? { id: planId, assignedUserId: userId }
    : { id: planId, userId };
  return prisma.monthlyPlan.findFirst({ where });
}

// ── List all plans ────────────────────────────────────────────
export async function list(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const { scientificRepId, month, year } = req.query;

    // rep users only see plans assigned to them
    const baseFilter = role === 'user'
      ? { assignedUserId: userId }
      : { userId };

    const where = { ...baseFilter };
    if (scientificRepId) where.scientificRepId = parseInt(scientificRepId);
    if (month)           where.month           = parseInt(month);
    if (year)            where.year            = parseInt(year);

    const plans = await prisma.monthlyPlan.findMany({
      where,
      include: {
        scientificRep:  { select: { id: true, name: true } },
        assignedUser:   { select: { id: true, username: true } },
        entries: {
          include: {
            doctor: { select: { id: true, name: true, specialty: true, pharmacyName: true, area: { select: { name: true } }, targetItem: { select: { id: true, name: true } } } },
            visits: { select: { id: true, feedback: true, visitDate: true, notes: true, latitude: true, longitude: true, item: { select: { id: true, name: true } } } },
            targetItems: { include: { item: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
          },
        },
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    res.json(plans);
  } catch (e) { next(e); }
}

// ── Get one plan ──────────────────────────────────────────────
export async function getOne(req, res, next) {
  try {
    const uid  = req.user.id;
    const role = req.user.role;
    const planId = parseInt(req.params.id);
    // owner sees by userId, assigned rep sees by assignedUserId
    const accessWhere = role === 'user'
      ? { id: planId, assignedUserId: uid }
      : { id: planId, userId: uid };
    const plan = await prisma.monthlyPlan.findFirst({
      where: accessWhere,
      include: {
        scientificRep: { select: { id: true, name: true } },
        entries: {
          include: {
            doctor: {
              include: {
                area:       { select: { id: true, name: true } },
                targetItem: { select: { id: true, name: true } },
              },
            },
            visits: { orderBy: { visitDate: 'asc' }, include: { item: { select: { id: true, name: true } } } },
            targetItems: { include: { item: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    if (!plan) return res.status(404).json({ error: 'Not found' });
    res.json(plan);
  } catch (e) { next(e); }
}

// ── Normalize Arabic text for note analysis ──────────────────
function normalizeAr(text) {
  return (text ?? '')
    .replace(/\u0640/g, '')           // tatweel
    .replace(/[\u064B-\u065F]/g, '')  // tashkeel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase();
}

// Keywords that indicate a positive/engaged doctor worth keeping in the plan.
// Applied to NORMALIZED Arabic text of visit notes.
const POSITIVE_NOTE_RE = new RegExp([
  // Follow-up / return visit
  'متابع', 'تابع', 'عوده', 'يعود', 'ارجع', 'رجوع', 'اعاده', 'اعود',
  'زياره قادمه', 'زياره اخرى', 'زياره تانيه', 'زياره ثانيه',
  'موعد اخر', 'يوم اخر', 'وقت اخر', 'وقت ثاني',
  // Samples request
  'سامبل', 'سمبل', 'عينه', 'عينات', 'نماذج', 'نموذج',
  // Bring someone / something
  'احضار', 'يحضر', 'احضر', 'تحضر',
  // Bring manager / supervisor
  'مدير', 'سوبر', 'مشرف', 'تيم ليدر', 'قائد الفريق', 'ليدر',
  // Doctor asked / enquired
  'سال', 'يسال', 'سوال', 'استفسار', 'استفسر', 'تساءل',
  // Doctor requested something from rep
  'طلب', 'يطلب', 'محتاج', 'يحتاج', 'احتياج', 'حاجه',
  // Reminder needed
  'تذكير', 'يذكر', 'ذكره', 'تذكر',
  // Study / research / data
  'دراسه', 'ابحاث', 'اثبت', 'احصائيات', 'نتائج دراسه', 'papers', 'مقاله',
  // Doctor agreed / promised
  'موافق', 'وافق', 'وعد', 'وعدني', 'اتفق', 'بيجرب',
  // Company / office inquiry
  'الشركه', 'المكتب', 'الوكيل',
  // Pharmacy follow-up
  'صيدليه', 'الصيدليه',
  // Trial / trying
  'تجربه', 'يجرب', 'تجريب',
  // Interested (in notes confirms engagement)
  'مهتم', 'مهتمه', 'منبسط', 'راضي',
  // Will contact
  'اتصل', 'تواصل', 'يتواصل',
].join('|'));

// ── Smart suggestion for new plan ────────────────────────────
// Logic: take prev month visits, keep positive feedback, replace negative with new doctors from survey
export async function suggest(req, res, next) {
  try {
    const userId = req.user.id;
    const {
      scientificRepId, month, year,
      targetDoctors = 75,
      keepFeedback,          // comma-separated e.g. 'writing,stocked,interested'
      restrictToAreas = 'true',
      sortBy = 'oldest',     // 'oldest' | 'newest' | 'random'
      useNoteAnalysis = 'true',  // analyze visit notes for positive signals
    } = req.query;
    if (!scientificRepId || !month || !year)
      return res.status(400).json({ error: 'scientificRepId, month, year required' });

    const repId  = parseInt(scientificRepId);
    const m      = parseInt(month);
    const y      = parseInt(year);
    const target = parseInt(targetDoctors);

    const KEEP_FEEDBACK = keepFeedback
      ? String(keepFeedback).split(',').map(s => s.trim()).filter(Boolean)
      : ['writing', 'stocked', 'interested'];

    const analyzeNotes    = String(useNoteAnalysis) !== 'false';
    const useAreaRestriction = String(restrictToAreas) !== 'false';

    // Previous month
    const prevMonth = m === 1 ? 12 : m - 1;
    const prevYear  = m === 1 ? y - 1 : y;

    // Get previous plan visits (all visits so we can scan all notes)
    const prevPlan = await prisma.monthlyPlan.findFirst({
      where: { scientificRepId: repId, month: prevMonth, year: prevYear, userId },
      include: {
        entries: {
          include: {
            doctor:  true,
            visits:  { orderBy: { visitDate: 'desc' } },  // all visits for note analysis
          },
        },
      },
    });

    let keepDoctors    = [];
    let replacedCount  = 0;
    const usedDoctorIds = new Set();

    // Exclude doctors already added to the CURRENT plan
    const currentPlan = await prisma.monthlyPlan.findFirst({
      where: { scientificRepId: repId, month: m, year: y, userId },
      include: { entries: { select: { doctorId: true } } },
    });
    if (currentPlan) {
      currentPlan.entries.forEach(e => usedDoctorIds.add(e.doctorId));
    }

    if (prevPlan) {
      for (const entry of prevPlan.entries) {
        // Skip if doctor already in current plan
        if (usedDoctorIds.has(entry.doctor.id)) continue;
        const lastFeedback = entry.visits[0]?.feedback ?? 'pending';

        if (KEEP_FEEDBACK.includes(lastFeedback)) {
          keepDoctors.push({ doctor: entry.doctor, reason: lastFeedback });
          usedDoctorIds.add(entry.doctor.id);
        } else if (analyzeNotes) {
          // Scan ALL visit notes for positive engagement signals
          const allNotes = normalizeAr(
            entry.visits.map(v => v.notes ?? '').join(' ')
          );
          if (allNotes.trim() && POSITIVE_NOTE_RE.test(allNotes)) {
            keepDoctors.push({ doctor: entry.doctor, reason: 'positive_notes' });
            usedDoctorIds.add(entry.doctor.id);
          } else {
            replacedCount++;
          }
        } else {
          replacedCount++;
        }
      }
    }

    // Get scientific rep areas to find matching doctors
    const repAreas = await prisma.scientificRepArea.findMany({
      where: { scientificRepId: repId },
      select: { areaId: true },
    });
    const areaIds = repAreas.map(a => a.areaId);

    // Fill remaining slots with new doctors from survey (same areas)
    const needed = target - keepDoctors.length;
    let newDoctors = [];
    if (needed > 0) {
      const fetchCount = sortBy === 'random' ? Math.min(needed * 4, 500) : needed;
      newDoctors = await prisma.doctor.findMany({
        where: {
          userId,
          isActive: true,
          id: { notIn: [...usedDoctorIds] },
          ...(useAreaRestriction && areaIds.length > 0 && { areaId: { in: areaIds } }),
        },
        include: {
          area:       { select: { id: true, name: true } },
          targetItem: { select: { id: true, name: true } },
        },
        take: fetchCount,
        orderBy: sortBy === 'newest' ? { createdAt: 'desc' } : { createdAt: 'asc' },
      });
      if (sortBy === 'random') {
        newDoctors = newDoctors.sort(() => Math.random() - 0.5).slice(0, needed);
      }
    }

    res.json({
      keepDoctors,
      newDoctors,
      summary: {
        keep:    keepDoctors.length,
        replace: replacedCount,
        new:     newDoctors.length,
        total:   keepDoctors.length + newDoctors.length,
      },
    });
  } catch (e) { next(e); }
}

// ── Create plan ───────────────────────────────────────────────
export async function create(req, res, next) {
  try {
    const userId = req.user.id;
    const { scientificRepId, month, year, targetCalls, targetDoctors, notes, doctorIds } = req.body;
    if (!scientificRepId || !month || !year)
      return res.status(400).json({ error: 'scientificRepId, month, year required' });

    const plan = await prisma.monthlyPlan.create({
      data: {
        scientificRepId: parseInt(scientificRepId),
        month: parseInt(month),
        year:  parseInt(year),
        targetCalls:   targetCalls   ? parseInt(targetCalls)   : 150,
        targetDoctors: targetDoctors ? parseInt(targetDoctors) : 75,
        notes,
        userId,
        entries: doctorIds?.length ? {
          create: doctorIds.map(id => ({ doctorId: parseInt(id), targetVisits: 2 })),
        } : undefined,
      },
      include: {
        scientificRep: { select: { id: true, name: true } },
        entries: { include: { doctor: true } },
      },
    });
    res.status(201).json(plan);
  } catch (e) { next(e); }
}

// ── Update plan ───────────────────────────────────────────────
export async function update(req, res, next) {
  try {
    const { notes, status, targetCalls, targetDoctors, allowExtraVisits } = req.body;
    const result = await prisma.monthlyPlan.updateMany({
      where: { id: parseInt(req.params.id), userId: req.user.id },
      data: {
        ...(notes             !== undefined && { notes }),
        ...(status            !== undefined && { status }),
        ...(targetCalls       !== undefined && { targetCalls:       parseInt(targetCalls) }),
        ...(targetDoctors     !== undefined && { targetDoctors:     parseInt(targetDoctors) }),
        ...(allowExtraVisits  !== undefined && { allowExtraVisits:  Boolean(allowExtraVisits) }),
      },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Delete plan ───────────────────────────────────────────────
export async function remove(req, res, next) {
  try {
    const result = await prisma.monthlyPlan.deleteMany({
      where: { id: parseInt(req.params.id), userId: req.user.id },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Add doctor entry to plan ──────────────────────────────────
export async function addEntry(req, res, next) {
  try {
    const planId   = parseInt(req.params.id);
    const { doctorId, targetVisits } = req.body;

    // Verify plan belongs to user (only owners can add entries)
    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const entry = await prisma.planEntry.create({
      data: { planId, doctorId: parseInt(doctorId), targetVisits: targetVisits ?? 2 },
      include: { doctor: { include: { area: true, targetItem: true } } },
    });
    res.status(201).json(entry);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Doctor already in plan' });
    next(e);
  }
}

// ── Remove doctor entry from plan ────────────────────────────
export async function removeEntry(req, res, next) {
  try {
    const planId   = parseInt(req.params.id);
    const entryId  = parseInt(req.params.entryId);

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    await prisma.planEntry.delete({ where: { id: entryId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Bulk remove entries from plan ────────────────────────────
export async function bulkRemoveEntries(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const { entryIds } = req.body;           // number[]

    if (!Array.isArray(entryIds) || entryIds.length === 0)
      return res.status(400).json({ error: 'entryIds required' });

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const ids = entryIds.map(Number).filter(n => !isNaN(n));

    const result = await prisma.planEntry.deleteMany({
      where: { id: { in: ids }, planId },
    });
    res.json({ success: true, deleted: result.count });
  } catch (e) { next(e); }
}

export async function patchEntry(req, res, next) {
  try {
    const planId  = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const { targetVisits } = req.body;

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const entry = await prisma.planEntry.update({
      where: { id: entryId },
      data:  { targetVisits: parseInt(targetVisits) },
    });
    res.json(entry);
  } catch (e) { next(e); }
}

// ── Add item to plan entry ────────────────────────────────────
export async function addEntryItem(req, res, next) {
  try {
    const planId  = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const record = await prisma.planEntryItem.create({
      data: { planEntryId: entryId, itemId: parseInt(itemId) },
      include: { item: { select: { id: true, name: true } } },
    });
    res.status(201).json(record);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Item already added' });
    next(e);
  }
}

// ── Remove item from plan entry ───────────────────────────────
export async function removeEntryItem(req, res, next) {
  try {
    const planId  = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const itemId  = parseInt(req.params.itemId);

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    await prisma.planEntryItem.deleteMany({
      where: { planEntryId: entryId, itemId },
    });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Add manual visit ──────────────────────────────────────────
export async function addVisit(req, res, next) {
  try {
    const planId  = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const userId  = req.user.id;
    const role    = req.user.role;
    const { visitDate, itemId, feedback, notes, latitude, longitude } = req.body;

    const plan = await findAccessiblePlan(planId, userId, role);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const entry = await prisma.planEntry.findFirst({ where: { id: entryId, planId } });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const visit = await prisma.doctorVisit.create({
      data: {
        doctorId:        entry.doctorId,
        scientificRepId: plan.scientificRepId,
        planEntryId:     entryId,
        visitDate:       visitDate ? new Date(visitDate) : new Date(),
        itemId:          itemId ? parseInt(itemId) : null,
        feedback:        feedback ?? 'pending',
        notes:           notes ?? '',
        latitude:        latitude  != null ? parseFloat(latitude)  : null,
        longitude:       longitude != null ? parseFloat(longitude) : null,
        userId,
      },
      include: { item: { select: { id: true, name: true } } },
    });
    res.status(201).json(visit);
  } catch (e) { next(e); }
}

// ── Delete visit ──────────────────────────────────────────────
export async function deleteVisit(req, res, next) {
  try {
    const visitId = parseInt(req.params.visitId);
    const visit = await prisma.doctorVisit.findFirst({
      where: { id: visitId, userId: req.user.id },
    });
    if (!visit) return res.status(404).json({ error: 'Visit not found' });
    await prisma.doctorVisit.delete({ where: { id: visitId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Update visit item ────────────────────────────────────────────
export async function patchVisitItem(req, res, next) {
  try {
    const visitId = parseInt(req.params.visitId);
    const { itemId } = req.body;

    // التحقق من ملكية الزيارة
    const visit = await prisma.doctorVisit.findFirst({
      where: { id: visitId, userId: req.user.id },
    });
    if (!visit) return res.status(404).json({ error: 'Visit not found' });

    const updated = await prisma.doctorVisit.update({
      where: { id: visitId },
      data:  { itemId: itemId ? parseInt(itemId) : null },
      include: { item: { select: { id: true, name: true } } },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

// ── Import visits from Excel — linked to a specific plan ─────
// Accepts any column order / naming — smart fuzzy column detection
export async function importPlanVisits(req, res, next) {
  try {
    const userId = req.user.id;
    const planId = parseInt(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Load the plan with entries + doctors (accessible by owner or assigned rep)
    const role = req.user.role;
    const planBase = await findAccessiblePlan(planId, userId, role);
    if (!planBase) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Plan not found' }); }
    const plan = await prisma.monthlyPlan.findFirst({
      where: { id: planId },
      include: {
        scientificRep: true,
        entries: {
          include: {
            doctor: true,
            targetItems: { include: { item: true } },
          },
        },
      },
    });

    const workbook = XLSX.readFile(req.file.path);
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    fs.unlink(req.file.path, () => {});

    if (rows.length === 0) return res.json({ imported: 0, errors: [], unmatched: [], total: 0 });

    // ── 1. Smart column header detection ────────────────────────
    // Normalise a header: lowercase, strip spaces/underscores/dashes, strip Arabic diacritics
    const normHeader = s => String(s ?? '')
      .toLowerCase()
      .replace(/[\u064B-\u065F]/g, '')   // strip Arabic diacritics
      .replace(/[\s_\-\.]+/g, '')         // strip whitespace / separators
      .trim();

    // Alias groups — any header matching one of these strings (after normHeader) → that field
    const ALIASES = {
      doctor: ['اسمالطبيب','الطبيب','طبيب','اسم','doctorname','doctor','doctors','physician','patientname','drname','dr'],
      date:   ['تاريخالزيارة','تاريخزيارة','تاريخ','زياره','زيارة','visitdate','date','visitday','day','تاريخزياره'],
      item:   ['الايتم','ايتم','الدواء','الادوية','الدوية','دواء','منتج','iteam','item','items','medicine','drug','product','препарат'],
      feedback:['الفيدباك','فيدباك','النتيجه','النتيجة','نتيجه','نتيجة','الحاله','الحالة','حالة','feedback','result','status','outcome'],
      notes:  ['ملاحظات','ملاحظه','ملاحظة','notes','note','تعليقات','تعليق','comment','comments','remarks'],
    };

    // Build a map: original header key → field name
    const headers    = Object.keys(rows[0]);
    const colMap     = {}; // field → original header key

    for (const header of headers) {
      const n = normHeader(header);
      for (const [field, aliases] of Object.entries(ALIASES)) {
        if (!colMap[field] && aliases.some(a => a === n || n.includes(a) || a.includes(n))) {
          colMap[field] = header;
          break;
        }
      }
    }

    // Helper: get cell value for a field with fallback to ''
    const getCell = (row, field) => {
      const key = colMap[field];
      return key !== undefined ? row[key] : '';
    };

    // ── 2. Feedback normalisation ────────────────────────────────
    const FEEDBACK_MAP = {
      'يكتب':         'writing',
      'writing':      'writing',
      'نزل':          'stocked',
      'نزلالايتم':    'stocked',
      'مخزون':        'stocked',
      'stocked':      'stocked',
      'مهتم':         'interested',
      'interested':   'interested',
      'يتابع':        'interested',
      'follow':       'interested',
      'غيرمهتم':      'not_interested',
      'notinterested':'not_interested',
      'not_interested':'not_interested',
      'غيرمتوفر':     'unavailable',
      'unavailable':  'unavailable',
      'معلق':         'pending',
      'pending':      'pending',
    };

    const parseFeedback = (raw) => {
      const n = normHeader(raw);
      if (!n) return 'pending';
      if (FEEDBACK_MAP[n]) return FEEDBACK_MAP[n];
      // partial containment
      for (const [k, v] of Object.entries(FEEDBACK_MAP)) {
        if (n.includes(k) || k.includes(n)) return v;
      }
      return 'pending';
    };

    // ── 3. Date parsing (multi-format) ───────────────────────────
    // Arabic month names → month number
    const AR_MONTHS = { 'يناير':1,'جانوري':1,'فبراير':2,'مارس':3,'أبريل':4,'ابريل':4,'مايو':5,
      'يونيو':6,'يوليو':7,'أغسطس':8,'اغسطس':8,'سبتمبر':9,'اكتوبر':10,'أكتوبر':10,
      'نوفمبر':11,'ديسمبر':12 };

    const parseDate = (raw) => {
      if (!raw && raw !== 0) return new Date();

      // XLSX serial number (number type)
      if (typeof raw === 'number') {
        const d = new Date(Math.round((raw - 25569) * 864e5));
        if (!isNaN(d.getTime())) return d;
      }

      const s = String(raw).trim();
      if (!s) return new Date();

      // Try native Date first (handles ISO 8601 and many locale strings)
      const native = new Date(s);
      if (!isNaN(native.getTime())) return native;

      // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
      const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
      if (dmy) {
        let [, d, m, y] = dmy.map(Number);
        if (y < 100) y += y < 50 ? 2000 : 1900;
        // If month > 12, swap day/month
        if (m > 12) [d, m] = [m, d];
        const dt = new Date(y, m - 1, d);
        if (!isNaN(dt.getTime())) return dt;
      }

      // Arabic format: "6 مارس 2026" or "2026 مارس 6"
      for (const [arName, mNum] of Object.entries(AR_MONTHS)) {
        if (s.includes(arName)) {
          const nums = s.match(/\d+/g) ?? [];
          if (nums.length >= 2) {
            const n1 = parseInt(nums[0]), n2 = parseInt(nums[nums.length - 1]);
            const y = n2 > 100 ? n2 : n1 > 100 ? n1 : new Date().getFullYear();
            const d = n1 <= 31 && n1 !== y ? n1 : 1;
            const dt = new Date(y, mNum - 1, d);
            if (!isNaN(dt.getTime())) return dt;
          }
        }
      }

      return new Date(); // fallback to today
    };

    // ── 4. Doctor / item fuzzy matching ──────────────────────────
    const normalize = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

    const entryMap = new Map();
    for (const entry of plan.entries) {
      entryMap.set(normalize(entry.doctor.name), entry);
    }

    const findEntry = (rawName) => {
      const n = normalize(rawName);
      if (!n) return null;
      if (entryMap.has(n)) return entryMap.get(n);
      // contains check (both directions)
      for (const [key, entry] of entryMap) {
        if (key.includes(n) || n.includes(key)) return entry;
      }
      // word-overlap: count shared words ≥ 2 chars
      const words = n.split(/\s+/).filter(w => w.length >= 2);
      let bestScore = 0, bestEntry = null;
      for (const [key, entry] of entryMap) {
        const keyWords = key.split(/\s+/).filter(w => w.length >= 2);
        const shared = words.filter(w => keyWords.some(kw => kw.includes(w) || w.includes(kw)));
        if (shared.length > bestScore) { bestScore = shared.length; bestEntry = entry; }
      }
      return bestScore >= 1 ? bestEntry : null;
    };

    const allItems = await prisma.item.findMany({ where: { userId } });
    const itemMap  = new Map(allItems.map(it => [normalize(it.name), it]));

    // Extract numeric tokens (dose/strength) from a name string
    // "air tide 250"     → nums=["250"],         text=["air","tide"]
    // "air tide 250/50"  → nums=["250/50","250","50"], text=["air","tide"]
    // "airtide 100 mcg/50 mcg" → nums=["100","mcg/50","50"], text=["airtide","mcg"]
    const extractTokens = (s) => {
      const words = s.split(/\s+/);
      const text    = words.filter(w => !/\d/.test(w) && w.length >= 2);
      const rawNums = words.filter(w => /\d/.test(w));
      const nums = [];
      for (const t of rawNums) {
        nums.push(t);
        // expand slash combos — only push parts that actually contain a digit
        for (const part of t.split('/')) {
          if (part && /\d/.test(part) && !nums.includes(part)) nums.push(part);
        }
      }
      return { text, nums };
    };

    // text-word similarity: how many srcText words appear inside keyText words
    const textSim = (srcText, keyText) =>
      srcText.filter(w => keyText.some(kw => kw.includes(w) || w.includes(kw))).length;

    // numeric similarity: any srcNum matches keyNum considering dose fractions
    // "250" matches "250/50" because "250/50".startsWith("250/")
    const numMatches = (srcNums, keyNums) =>
      srcNums.some(num =>
        keyNums.some(kn =>
          kn === num ||
          kn.startsWith(num + '/') ||
          num.startsWith(kn + '/')
        )
      );

    const findItem = (rawName) => {
      const n = normalize(rawName);
      if (!n) return null;

      // 1. Exact match
      if (itemMap.has(n)) return itemMap.get(n);

      const { text: srcText, nums: srcNums } = extractTokens(n);

      // 2. Query has dose numbers → search for items that share text AND dose
      //    "air tide 250" → matches "air tide 250/50" ✓ (250 == 250 of 250/50)
      if (srcNums.length > 0 && srcText.length > 0) {
        let bestScore = 0, bestDose = null;
        for (const [key, item] of itemMap) {
          const { text: keyText, nums: keyNums } = extractTokens(key);
          if (keyNums.length === 0) continue; // skip doseless items
          if (!numMatches(srcNums, keyNums)) continue; // dose must match
          const tSim = textSim(srcText, keyText);
          if (tSim === 0) continue;
          const score = tSim * 2 + srcNums.filter(num =>
            keyNums.some(kn => kn === num || kn.startsWith(num + '/') || num.startsWith(kn + '/'))
          ).length;
          if (score > bestScore) { bestScore = score; bestDose = item; }
        }
        if (bestDose) return bestDose;

        // 2b. Dose not found exactly → prefer same-drug dosed items over doseless items
        //     "air tide 250" with only "AIRTIDE 100/50" in DB → returns "AIRTIDE 100/50"
        //     (better than silently returning the doseless "air tide")
        let bestTextDosed = null, bestTextDosedScore = 0;
        for (const [key, item] of itemMap) {
          const { text: keyText, nums: keyNums } = extractTokens(key);
          if (keyNums.length === 0) continue; // still skip doseless
          const tSim = textSim(srcText, keyText);
          if (tSim > bestTextDosedScore) { bestTextDosedScore = tSim; bestTextDosed = item; }
        }
        if (bestTextDosed && bestTextDosedScore > 0) return bestTextDosed;
      }

      // 3. No dose in query OR no dosed item matched → plain contains (prefer longest)
      let bestContains = null, bestLen = 0;
      for (const [key, item] of itemMap) {
        if (key.includes(n) || n.includes(key)) {
          if (key.length > bestLen) { bestLen = key.length; bestContains = item; }
        }
      }
      return bestContains;
    };

    // ── 5. Process rows ──────────────────────────────────────────
    let imported  = 0;
    const errors  = [];
    const unmatched = [];
    const itemsMatched = []; // [{ rowExcel, doctor, itemInExcel, itemMatched, matchType }]


    for (let i = 0; i < rows.length; i++) {
      const row        = rows[i];
      const doctorName = String(getCell(row, 'doctor') ?? '').trim();
      const visitDateRaw = getCell(row, 'date');
      const itemName   = String(getCell(row, 'item')     ?? '').trim();
      const feedbackRaw = String(getCell(row, 'feedback') ?? '').trim();
      const notes      = String(getCell(row, 'notes')    ?? '').trim();

      if (!doctorName) { errors.push({ row: i + 2, error: 'اسم الطبيب فارغ' }); continue; }

      let entry = findEntry(doctorName);
      if (!entry) {
        if (!allowExtraVisits) {
          unmatched.push(doctorName);
          errors.push({ row: i + 2, error: `الطبيب "${doctorName}" غير موجود في البلان` });
          continue;
        }
        // allowExtraVisits = true → find/create doctor then find/create planEntry
        let doctor = await prisma.doctor.findFirst({ where: { userId, name: doctorName } });
        if (!doctor) {
          doctor = await prisma.doctor.create({
            data: { name: doctorName, userId },
            select: { id: true, name: true },
          });
        }
        const newEntry = await prisma.planEntry.upsert({
          where:  { planId_doctorId: { planId: plan.id, doctorId: doctor.id } },
          create: { planId: plan.id, doctorId: doctor.id, targetVisits: 1 },
          update: {},
          include: {
            doctor:      { select: { id: true, name: true } },
            targetItems: { include: { item: { select: { id: true, name: true } } } },
            visits:      { select: { id: true, feedback: true, visitDate: true, notes: true, item: { select: { id: true, name: true } } } },
          },
        });
        entry = newEntry;
        entryMap.set(normalize(doctorName), entry);
      }

      const parsedDate = parseDate(visitDateRaw);
      const feedback   = parseFeedback(feedbackRaw);

      // ── Resolve item: find in DB → or create if name given ──
      let resolvedItem = findItem(itemName);
      let matchType = resolvedItem ? 'fuzzy' : null;
      if (!resolvedItem && itemName) {
        try {
          resolvedItem = await prisma.item.upsert({
            where:  { name_userId: { name: itemName, userId } },
            update: {},
            create: { name: itemName, userId },
            select: { id: true, name: true },
          });
          matchType = 'created';
          itemMap.set(normalize(itemName), resolvedItem);
        } catch (_) { /* leave null */ }
      }
      if (normalize(itemName) === normalize(resolvedItem?.name ?? '')) matchType = 'exact';
      if (itemName) itemsMatched.push({
        row: i + 2, doctor: doctorName,
        itemInExcel: itemName,
        itemMatched: resolvedItem?.name ?? null,
        matchType,
      });

      const resolvedItemId = resolvedItem?.id ?? (entry.targetItems[0]?.item?.id ?? null);

      await prisma.doctorVisit.create({
        data: {
          doctorId:        entry.doctorId,
          scientificRepId: plan.scientificRepId,
          planEntryId:     entry.id,
          visitDate:       parsedDate,
          itemId:          resolvedItemId,
          feedback,
          notes: notes || null,
          userId,
        },
      });

      // Always sync the item into the entry's target items (upsert handles duplicates)
      if (resolvedItem?.id) {
        await prisma.planEntryItem.upsert({
          where:  { planEntryId_itemId: { planEntryId: entry.id, itemId: resolvedItem.id } },
          create: { planEntryId: entry.id, itemId: resolvedItem.id },
          update: {},
        });
        // update in-memory cache so subsequent rows for the same doctor see the updated list
        if (!entry.targetItems.some(ti => ti.item.id === resolvedItem.id)) {
          entry.targetItems.push({ id: 0, item: { id: resolvedItem.id, name: resolvedItem.name } });
        }
      }

      imported++;
    }

    const uniqueUnmatched = [...new Set(unmatched)];
    res.json({ imported, errors, unmatched: uniqueUnmatched, total: rows.length, itemsMatched });
  } catch (e) { next(e); }
}

// ── Upload visits from Excel ──────────────────────────────────
// Expected columns: doctor_name, rep_name, visit_date, item_name, feedback, notes
export async function uploadVisits(req, res, next) {
  try {
    const userId = req.user.id;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = XLSX.readFile(req.file.path);
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    fs.unlink(req.file.path, () => {});

    const FEEDBACK_MAP = {
      'يكتب': 'writing', 'writing': 'writing',
      'مخزون': 'stocked', 'stocked': 'stocked', 'نزل الايتم': 'stocked',
      'مهتم': 'interested', 'interested': 'interested', 'يتابع': 'interested',
      'غير مهتم': 'not_interested', 'not_interested': 'not_interested',
      'غير متوفر': 'unavailable', 'unavailable': 'unavailable',
    };

    let imported = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const doctorName  = String(row['doctor_name'] || row['اسم الطبيب'] || '').trim();
      const repName     = String(row['rep_name']    || row['المندوب']    || '').trim();
      const visitDate   = row['visit_date'] || row['تاريخ الزيارة'];
      const itemName    = String(row['item_name']   || row['الايتم']     || '').trim();
      const feedbackRaw = String(row['feedback']    || row['الفيدباك']   || '').trim().toLowerCase();
      const notes       = String(row['notes']       || row['ملاحظات']    || '').trim();

      if (!doctorName || !repName || !visitDate) {
        errors.push({ row: i + 2, error: 'missing required fields' });
        continue;
      }

      // Find or create doctor
      let doctor = await prisma.doctor.findFirst({
        where: { name: { contains: doctorName }, userId },
      });
      if (!doctor) {
        doctor = await prisma.doctor.create({
          data: { name: doctorName, userId },
        });
      }

      // Find scientific rep
      const rep = await prisma.scientificRepresentative.findFirst({
        where: { name: { contains: repName }, userId },
      });
      if (!rep) { errors.push({ row: i + 2, error: `rep not found: ${repName}` }); continue; }

      // Find item
      let item = null;
      if (itemName) {
        item = await prisma.item.findFirst({ where: { name: { contains: itemName }, userId } });
      }

      // Parse date
      let parsedDate;
      if (typeof visitDate === 'number') {
        parsedDate = new Date(Math.round((visitDate - 25569) * 864e5));
      } else {
        parsedDate = new Date(visitDate);
      }
      if (isNaN(parsedDate.getTime())) {
        errors.push({ row: i + 2, error: `invalid date: ${visitDate}` });
        continue;
      }

      const feedback = FEEDBACK_MAP[feedbackRaw] ?? 'pending';

      await prisma.doctorVisit.create({
        data: {
          doctorId:       doctor.id,
          scientificRepId: rep.id,
          visitDate:      parsedDate,
          itemId:         item?.id ?? null,
          feedback,
          notes,
          userId,
        },
      });
      imported++;
    }

    res.json({ imported, errors, total: rows.length });
  } catch (e) { next(e); }
}

// ── Voice-to-visits: parse spoken text using Gemini AI ────────
export async function parseVoice(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const planId = parseInt(req.params.id);
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'لا يوجد نص' });

    const planAccess = await findAccessiblePlan(planId, userId, role);
    if (!planAccess) return res.status(404).json({ error: 'Plan not found' });

    const plan = await prisma.monthlyPlan.findFirst({
      where: { id: planId },
      include: {
        entries: {
          include: {
            doctor: { select: { id: true, name: true, specialty: true } },
            targetItems: { include: { item: { select: { id: true, name: true } } } },
          },
        },
      },
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const allItems = await prisma.item.findMany({ where: { userId }, select: { id: true, name: true } });

    const doctorNames = plan.entries.map(e => `${e.doctor.name} (id:${e.id})`).join('\n');
    const itemNames = allItems.map(i => `${i.name} (id:${i.id})`).join('\n');

    const feedbackValues = ['writing', 'stocked', 'interested', 'not_interested', 'unavailable', 'pending'];
    const feedbackAr = {
      'يكتب': 'writing', 'كاتب': 'writing', 'نزل': 'stocked', 'نزل الايتم': 'stocked',
      'مهتم': 'interested', 'غير مهتم': 'not_interested', 'مو مهتم': 'not_interested',
      'غير متوفر': 'unavailable', 'مو موجود': 'unavailable', 'معلق': 'pending',
    };

    const prompt = `أنت مساعد ذكي لتحليل كلام مندوب طبي. المندوب يتكلم عن زيارات قام بها لأطباء.

  قائمة الأطباء في البلان (اسم الطبيب و entry id):
  ${doctorNames}

  قائمة الأيتمات/الأدوية المتاحة (اكتب اسم الدواء كما هو بالضبط من القائمة فقط، ولا تخترع أسماء جديدة):
  ${itemNames}

  قيم الفيدباك المتاحة: ${feedbackValues.join(', ')}
  المقابلات بالعربي: ${Object.entries(feedbackAr).map(([k,v]) => `${k}=${v}`).join(', ')}

  النص المنطوق:
  "${text}"

  حلل النص واستخرج كل زيارة مذكورة. لكل زيارة أرجع:
  - entryId: رقم الـ entry id للطبيب من القائمة أعلاه (طابق الاسم حتى لو كان منطوق بشكل مختلف قليلاً)
  - doctorName: اسم الطبيب كما ورد
  - itemId: رقم id الايتم (null إذا لم يُذكر)
  - itemName: اسم الايتم كما ورد (اكتبه كما هو من القائمة فقط)
  - feedback: قيمة الفيدباك من القائمة أعلاه (pending إذا لم يُذكر)
  - notes: أي ملاحظات إضافية
  - date: التاريخ إذا ذُكر (YYYY-MM-DD) وإلا null

  مهم جداً: لا تكتب أي اسم دواء غير موجود في القائمة. إذا لم تتعرف على الدواء تجاهله أو اتركه فارغاً.

  أرجع JSON فقط بالشكل التالي بدون أي نص إضافي:
  {"visits": [{"entryId": 123, "doctorName": "...", "itemId": 456, "itemName": "...", "feedback": "writing", "notes": "", "date": null}]}`;

    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
    if (!apiKey) return res.status(500).json({ error: 'مفتاح Gemini غير مهيأ' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'تعذر تحليل الكلام', raw: responseText });

    const parsed = JSON.parse(jsonMatch[0]);
    // --- Fuzzy correction for item names ---
    const normalize = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const extractTokens = (s) => {
      const words = s.split(/\s+/);
      const text    = words.filter(w => !/\d/.test(w) && w.length >= 2);
      const rawNums = words.filter(w => /\d/.test(w));
      const nums = [];
      for (const t of rawNums) {
        nums.push(t);
        for (const part of t.split('/')) {
          if (part && /\d/.test(part) && !nums.includes(part)) nums.push(part);
        }
      }
      return { text, nums };
    };
    const textSim = (srcText, keyText) =>
      srcText.filter(w => keyText.some(kw => kw.includes(w) || w.includes(kw))).length;
    const numMatches = (srcNums, keyNums) =>
      srcNums.some(num =>
        keyNums.some(kn =>
          kn === num ||
          kn.startsWith(num + '/') ||
          num.startsWith(kn + '/')
        )
      );
    const itemMap = new Map(allItems.map(it => [normalize(it.name), it]));
    const findItem = (rawName) => {
      const n = normalize(rawName);
      if (!n) return null;
      if (itemMap.has(n)) return itemMap.get(n);
      const { text: srcText, nums: srcNums } = extractTokens(n);
      // Dose + text match
      if (srcNums.length > 0 && srcText.length > 0) {
        let bestScore = 0, bestDose = null;
        for (const [key, item] of itemMap) {
          const { text: keyText, nums: keyNums } = extractTokens(key);
          if (keyNums.length === 0) continue;
          if (!numMatches(srcNums, keyNums)) continue;
          const tSim = textSim(srcText, keyText);
          if (tSim === 0) continue;
          const score = tSim * 2 + srcNums.filter(num =>
            keyNums.some(kn => kn === num || kn.startsWith(num + '/') || num.startsWith(kn + '/'))
          ).length;
          if (score > bestScore) { bestScore = score; bestDose = item; }
        }
        if (bestDose) return bestDose;
        // Prefer same-drug dosed items over doseless
        let bestTextDosed = null, bestTextDosedScore = 0;
        for (const [key, item] of itemMap) {
          const { text: keyText, nums: keyNums } = extractTokens(key);
          if (keyNums.length === 0) continue;
          const tSim = textSim(srcText, keyText);
          if (tSim > bestTextDosedScore) { bestTextDosedScore = tSim; bestTextDosed = item; }
        }
        if (bestTextDosed && bestTextDosedScore > 0) return bestTextDosed;
      }
      // Contains
      let bestContains = null, bestLen = 0;
      for (const [key, item] of itemMap) {
        if (key.includes(n) || n.includes(key)) {
          if (key.length > bestLen) { bestLen = key.length; bestContains = item; }
        }
      }
      return bestContains;
    };

    const visits = (parsed.visits || []).map(v => {
      let itemId = v.itemId || null;
      let itemName = v.itemName || '';
      // إذا اسم الدواء غير مطابق لأي أيتم، صححه تلقائياً
      if (itemName && (!itemId || !allItems.some(it => it.id === itemId))) {
        const match = findItem(itemName);
        if (match) {
          itemId = match.id;
          itemName = match.name;
        }
      }
      return {
        entryId: v.entryId || null,
        doctorName: v.doctorName || '',
        itemId,
        itemName,
        feedback: feedbackValues.includes(v.feedback) ? v.feedback : 'pending',
        notes: v.notes || '',
        date: v.date || new Date().toISOString().split('T')[0],
      };
    });

    res.json({ visits, raw: text });
  } catch (e) {
    console.error('Voice parse error:', e);
    next(e);
  }
}

// ── parseVoiceAudio: receive audio blob, transcribe + parse via Gemini ─────────
export async function parseVoiceAudio(req, res, next) {
  try {
    const userId  = req.user.id;
    const role    = req.user.role;
    const planId  = parseInt(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف صوتي' });

    const planAccess = await findAccessiblePlan(planId, userId, role);
    if (!planAccess) return res.status(404).json({ error: 'Plan not found' });

    const plan = await prisma.monthlyPlan.findFirst({
      where: { id: planId },
      include: {
        entries: {
          include: {
            doctor: { select: { id: true, name: true, specialty: true } },
            targetItems: { include: { item: { select: { id: true, name: true } } } },
          },
        },
      },
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const allItems = await prisma.item.findMany({ where: { userId }, select: { id: true, name: true } });

    const audioData   = fs.readFileSync(req.file.path);
    const audioBase64 = audioData.toString('base64');
    const mimeType    = req.file.mimetype || 'audio/webm';
    fs.unlinkSync(req.file.path); // cleanup

    const doctorNames   = plan.entries.map(e => `${e.doctor.name} (id:${e.id})`).join('\n');
    const itemNames     = allItems.map(i => `${i.name} (id:${i.id})`).join('\n');
    const feedbackValues = ['writing', 'stocked', 'interested', 'not_interested', 'unavailable', 'pending'];
    const feedbackAr = {
      'يكتب': 'writing', 'كاتب': 'writing', 'نزل': 'stocked', 'نزل الايتم': 'stocked',
      'مهتم': 'interested', 'غير مهتم': 'not_interested', 'مو مهتم': 'not_interested',
      'غير متوفر': 'unavailable', 'مو موجود': 'unavailable', 'معلق': 'pending',
    };

    const prompt = `أنت مساعد ذكي لتحليل كلام مندوب طبي. استمع للتسجيل الصوتي واستخرج زيارات الأطباء.

قواعد صارمة جداً يجب اتباعها:
1. إذا التسجيل فارغ أو لا يوجد كلام واضح أو لا يُفهم → أرجع {"visits": []} فوراً بدون أي إضافة
2. إذا التسجيل يحتوي على ضوضاء فقط أو كلام غير مفهوم → أرجع {"visits": []}
3. لا تخترع أو تفترض أي زيارة لم تُذكر صراحةً في الكلام
4. لا تستخدم قائمة الأطباء أو الأيتمات كأساس للاقتراح — فقط ما قيل فعلاً بالصوت
5. إذا ذُكر اسم طبيب لكن لم يُذكر فيدباك واضح → اجعل feedback = "pending"
6. فقط الزيارات المذكورة صوتياً بشكل صريح تُضاف

قائمة الأطباء في البلان للمطابقة فقط (لا للاقتراح):
${doctorNames}

قائمة الأيتمات/الأدوية للمطابقة فقط:
${itemNames}

قيم الفيدباك المتاحة: ${feedbackValues.join(', ')}
المقابلات بالعربي: ${Object.entries(feedbackAr).map(([k,v]) => `${k}=${v}`).join(', ')}

أرجع JSON فقط بدون أي نص آخر:
{"visits": [{"entryId": 123, "doctorName": "...", "itemId": 456, "itemName": "...", "feedback": "writing", "notes": "", "date": null}]}

تذكير: إذا ما في كلام أو الكلام غير واضح → {"visits": []}}`;

    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
    if (!apiKey) return res.status(500).json({ error: 'مفتاح Gemini غير مهيأ' });

    const genAI  = new GoogleGenerativeAI(apiKey);
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent([
      { inlineData: { mimeType, data: audioBase64 } },
      prompt,
    ]);
    const responseText = result.response.text();
    const jsonMatch    = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'تعذر تحليل الصوت', raw: responseText });

    const parsed = JSON.parse(jsonMatch[0]);

    // Reuse same fuzzy item-matching logic
    const normalize  = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const itemMap    = new Map(allItems.map(it => [normalize(it.name), it]));
    const findItem   = (rawName) => {
      const n = normalize(rawName);
      if (!n) return null;
      if (itemMap.has(n)) return itemMap.get(n);
      let best = null, bestScore = 0;
      for (const [key, item] of itemMap) {
        if (key.includes(n) || n.includes(key)) {
          const score = key.length;
          if (score > bestScore) { bestScore = score; best = item; }
        }
      }
      return best;
    };

    // Build a set of valid entry IDs and a name→entryId map for fuzzy matching
    const entryMap = new Map(); // normalized name → entryId
    const validEntryIds = new Set(plan.entries.map(e => e.id));
    // Title prefixes to strip before matching (doctor titles, etc.)
    const TITLE_PREFIXES = /^(دكتور|دكتوره|د\.|دكتوراه|استاذ|استاذه|أستاذ|أستاذه|صيدلاني|صيدلانيه|مهندس|مهندسه|حاج|حاجه)\s+/g;

    const normalizeAr = s => String(s ?? '').trim().toLowerCase()
      .replace(/أ|إ|آ/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ');

    // Strip title AND normalize
    const cleanName = s => normalizeAr(s.replace(TITLE_PREFIXES, ''));

    for (const e of plan.entries) {
      entryMap.set(cleanName(e.doctor.name), e.id);
    }

    const findEntry = (rawName, geminiEntryId) => {
      const n = cleanName(rawName);
      if (!n) return null;

      // 1. Exact match by cleaned name
      if (entryMap.has(n)) return entryMap.get(n);

      // 2. If Gemini suggested entryId AND the cleaned names are exactly equal → accept
      if (geminiEntryId && validEntryIds.has(geminiEntryId)) {
        const matchedEntry = plan.entries.find(e => e.id === geminiEntryId);
        if (matchedEntry && cleanName(matchedEntry.doctor.name) === n) {
          return geminiEntryId;
        }
      }

      // 3. Strict containment: one name fully contains the other AND
      //    the shorter must have >= 2 words AND cover >= 70% of the longer
      for (const [key, id] of entryMap) {
        if (key === n) return id; // exact (already checked but safe)
        if (key.includes(n) || n.includes(key)) {
          const shorter = Math.min(key.length, n.length);
          const longer  = Math.max(key.length, n.length);
          const shorterStr = key.length < n.length ? key : n;
          const wordCount  = shorterStr.split(' ').filter(t => t.length >= 2).length;
          if (wordCount >= 2 && shorter / longer >= 0.7) {
            return id;
          }
        }
      }

      // 4. ALL tokens from voice name must appear in plan name (and vice versa)
      //    Both must have >= 2 words and ALL must match
      const nWords = n.split(' ').filter(t => t.length >= 2);
      if (nWords.length >= 2) {
        for (const [key, id] of entryMap) {
          const keyWords = key.split(' ').filter(t => t.length >= 2);
          if (keyWords.length >= 2) {
            const allVoiceInPlan = nWords.every(t => keyWords.includes(t));
            const allPlanInVoice = keyWords.every(t => nWords.includes(t));
            if (allVoiceInPlan || allPlanInVoice) return id;
          }
        }
      }

      // No confident match → return null (user picks from dropdown)
      return null;
    };

    const visits = (parsed.visits || []).map(v => {
      let itemId = v.itemId || null;
      let itemName = v.itemName || '';
      if (itemName && (!itemId || !allItems.some(it => it.id === itemId))) {
        const match = findItem(itemName);
        if (match) { itemId = match.id; itemName = match.name; }
      }
      // Validate/resolve entryId — null means doctor is NOT in the plan
      const resolvedEntryId = findEntry(v.doctorName, v.entryId || null);
      return {
        entryId:    resolvedEntryId,
        doctorName: v.doctorName || '',
        itemId,
        itemName,
        feedback:   feedbackValues.includes(v.feedback) ? v.feedback : 'pending',
        notes:      v.notes || '',
        date:       v.date  || new Date().toISOString().split('T')[0],
      };
    });

    res.json({ visits, raw: responseText });
  } catch (e) {
    console.error('Voice audio parse error:', e);
    next(e);
  }
}

// ── Transfer (assign) plan to a rep user account ─────────────
// POST /api/monthly-plans/:id/transfer { targetUserId }
// Only the plan owner (admin/manager) can transfer.
// targetUserId must be a 'user'-role account whose linkedRepId matches the plan's scientificRepId.
export async function transferPlan(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId مطلوب.' });
    }

    // Only admin / manager can transfer
    const role = req.user.role;
    if (role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ error: 'تحويل البلان متاح للمدير فقط.' });
    }

    // Verify plan belongs to the calling user
    const plan = await prisma.monthlyPlan.findFirst({
      where: { id: planId, userId: req.user.id },
    });
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود أو لا تملك صلاحية تحويله.' });

    // Verify target user exists, is a 'user' role, and their linked rep matches the plan's rep
    const targetUser = await prisma.user.findUnique({
      where: { id: parseInt(targetUserId) },
      select: { id: true, username: true, role: true, linkedRepId: true, isActive: true },
    });
    if (!targetUser || !targetUser.isActive) {
      return res.status(404).json({ error: 'المستخدم المحدد غير موجود أو غير نشط.' });
    }
    if (targetUser.role !== 'user') {
      return res.status(400).json({ error: 'يمكن تحويل البلان إلى حسابات المندوبين فقط (دور: مستخدم).' });
    }
    if (targetUser.linkedRepId !== plan.scientificRepId) {
      return res.status(400).json({ error: 'حساب المستخدم المحدد غير مرتبط بنفس المندوب العلمي الخاص بهذا البلان.' });
    }

    // Perform the transfer
    const updated = await prisma.monthlyPlan.update({
      where: { id: planId },
      data:  { assignedUserId: targetUser.id },
      select: { id: true, assignedUserId: true },
    });

    res.json({ success: true, assignedUserId: updated.assignedUserId, username: targetUser.username });
  } catch (e) { next(e); }
}

// ── Revoke (un-assign) a plan from a rep user ────────────────
// DELETE /api/monthly-plans/:id/transfer
export async function revokePlanTransfer(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const role   = req.user.role;
    if (role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ error: 'إلغاء التحويل متاح للمدير فقط.' });
    }

    const plan = await prisma.monthlyPlan.findFirst({
      where: { id: planId, userId: req.user.id },
    });
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود.' });

    await prisma.monthlyPlan.update({ where: { id: planId }, data: { assignedUserId: null } });
    res.json({ success: true });
  } catch (e) { next(e); }
}
