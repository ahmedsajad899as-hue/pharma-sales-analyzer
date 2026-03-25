import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Helper: pick best available Gemini API key ──────────────
function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY_1
    || process.env.GEMINI_API_KEY_2
    || process.env.GEMINI_API_KEY_3
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || '';
}

// ── Helper: find a plan the user has access to ──────────────
// - owner (admin/manager): plans where userId = myId
// - assigned rep (any rep role): plans where assignedUserId = myId
const REP_ROLES = new Set(['user','scientific_rep','team_leader','supervisor','commercial_rep']);
async function findAccessiblePlan(planId, userId, role) {
  if (REP_ROLES.has(role)) {
    // Rep can access plan either as assigned user OR as owner
    return prisma.monthlyPlan.findFirst({
      where: { id: planId, OR: [{ assignedUserId: userId }, { userId }] },
    });
  }
  return prisma.monthlyPlan.findFirst({ where: { id: planId, userId } });
}

// ── Helper: recalculate targetCalls & targetDoctors from entries ──
async function recalcTargetCalls(planId) {
  const entries = await prisma.planEntry.findMany({ where: { planId }, select: { targetVisits: true } });
  const targetCalls = entries.reduce((sum, e) => sum + (e.targetVisits || 2), 0);
  const targetDoctors = entries.length;
  await prisma.monthlyPlan.update({ where: { id: planId }, data: { targetCalls, targetDoctors } });
}

// ── List all plans ────────────────────────────────────────────
export async function list(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const { scientificRepId, month, year } = req.query;

    // rep roles see plans they created OR assigned to them; managers/admins see plans they created
    const REP_ROLES = new Set(['user','scientific_rep','team_leader','supervisor','commercial_rep']);
    const baseFilter = REP_ROLES.has(role)
      ? { OR: [{ userId }, { assignedUserId: userId }] }
      : { userId };

    const where = { ...baseFilter };
    if (scientificRepId) where.scientificRepId = parseInt(scientificRepId);
    if (month)           where.month           = parseInt(month);
    if (year)            where.year            = parseInt(year);

    const plans = await prisma.monthlyPlan.findMany({
      where,
      include: {
        scientificRep:  { select: { id: true, name: true } },
        user:           { select: { id: true, username: true } },
        assignedUser:   { select: { id: true, username: true } },
        planAreas:      { include: { area: { select: { id: true, name: true } } } },
        entries: {
          include: {
            doctor: { select: { id: true, name: true, specialty: true, pharmacyName: true, area: { select: { name: true } }, targetItem: { select: { id: true, name: true } } } },
            visits: { select: { id: true, feedback: true, visitDate: true, notes: true, latitude: true, longitude: true, item: { select: { id: true, name: true } }, likes: { select: { id: true, userId: true, user: { select: { id: true, username: true } } } }, comments: { select: { id: true, userId: true, content: true, createdAt: true, user: { select: { id: true, username: true } } }, orderBy: { createdAt: 'asc' } } } },
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
    // owner sees by userId, assigned rep sees by assignedUserId OR own created plan
    const REP_ROLES_ONE = new Set(['user','scientific_rep','team_leader','supervisor','commercial_rep']);
    const accessWhere = REP_ROLES_ONE.has(role)
      ? { id: planId, OR: [{ assignedUserId: uid }, { userId: uid }] }
      : { id: planId, userId: uid };
    const plan = await prisma.monthlyPlan.findFirst({
      where: accessWhere,
      include: {
        scientificRep: { select: { id: true, name: true } },
        planAreas:     { include: { area: { select: { id: true, name: true } } } },
        entries: {
          include: {
            doctor: {
              include: {
                area:       { select: { id: true, name: true } },
                targetItem: { select: { id: true, name: true } },
              },
            },
            visits: { orderBy: { visitDate: 'asc' }, include: { item: { select: { id: true, name: true } }, likes: { select: { id: true, userId: true, user: { select: { id: true, username: true } } } }, comments: { select: { id: true, userId: true, content: true, createdAt: true, user: { select: { id: true, username: true } } }, orderBy: { createdAt: 'asc' } } } },
            targetItems: { include: { item: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    if (!plan) return res.status(404).json({ error: 'غير موجود' });
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
      scientificRepId, planId: qPlanId, month, year,
      targetDoctors = 75,
      keepFeedback,
      restrictToAreas = 'true',
      sortBy = 'oldest',
      useNoteAnalysis = 'true',
      userNote = '',
      lookbackMonths = '1',
      lookbackList = '',     // comma-separated YYYY-MM, overrides lookbackMonths if set
      newRatio = '0',        // 0 = auto, 1-100 = force % of target to be new doctors
      focusItemId = '',      // filter new doctors by item
      focusSpecialty = '',   // filter new doctors by specialty
      focusAreaId = '',      // override area filter for new doctors
      wishedDoctorIds = '',  // comma-separated doctor IDs from rep wishlist (قائمة الطلبات)
      areaQuotas = '',       // JSON string e.g. '{"1":10,"4":5}' — per-area doctor quotas
    } = req.query;

    // ── NO-REP plan mode: use planId + planAreas ──────────────
    const noRepMode = !scientificRepId && qPlanId;
    let planAreaIds = [];
    if (noRepMode) {
      if (!month || !year) return res.status(400).json({ error: 'الحقول المطلوبة: planId, month, year' });
      const pa = await prisma.planArea.findMany({ where: { planId: parseInt(qPlanId) }, select: { areaId: true } });
      planAreaIds = pa.map(a => a.areaId);
      if (planAreaIds.length === 0) return res.status(400).json({ error: 'لا توجد مناطق محددة لهذا البلان. أضف مناطق أولاً.' });
    } else {
      if (!scientificRepId || !month || !year)
        return res.status(400).json({ error: 'الحقول المطلوبة: scientificRepId, month, year' });
    }

    const repId  = scientificRepId ? parseInt(scientificRepId) : null;
    const m      = parseInt(month);
    const y      = parseInt(year);
    const target = parseInt(targetDoctors);

    const KEEP_FEEDBACK = keepFeedback
      ? String(keepFeedback).split(',').map(s => s.trim()).filter(Boolean)
      : ['writing', 'stocked', 'interested'];

    const analyzeNotes    = String(useNoteAnalysis) !== 'false';
    const useAreaRestriction = String(restrictToAreas) !== 'false';

    // Build list of previous months to scan
    // If lookbackList is provided (comma-separated YYYY-MM), use it; otherwise fall back to lookbackMonths count
    let prevMonthsList;
    if (String(lookbackList).trim()) {
      prevMonthsList = String(lookbackList).split(',')
        .map(s => s.trim()).filter(Boolean)
        .map(ym => { const [yr, mo] = ym.split('-').map(Number); return { month: mo, year: yr }; })
        .filter(p => p.month >= 1 && p.month <= 12 && p.year > 2000);
    } else {
      const lookback = Math.max(1, Math.min(6, parseInt(lookbackMonths) || 1));
      prevMonthsList = [];
      for (let i = 1; i <= lookback; i++) {
        let pm = m - i; let py = y;
        if (pm <= 0) { pm += 12; py -= 1; }
        prevMonthsList.push({ month: pm, year: py });
      }
    }
    if (prevMonthsList.length === 0) {
      prevMonthsList = [{ month: m === 1 ? 12 : m - 1, year: m === 1 ? y - 1 : y }];
    }

    // Get previous plans for all lookback months (skip for no-rep plans)
    let prevPlans = [];
    if (!noRepMode) {
      prevPlans = await prisma.monthlyPlan.findMany({
        where: {
          scientificRepId: repId, userId,
          OR: prevMonthsList.map(p => ({ month: p.month, year: p.year })),
        },
        include: {
          entries: {
            include: {
              doctor: true,
              visits: { orderBy: { visitDate: 'desc' } },
            },
          },
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      });
    }

    let keepDoctors    = [];
    let replacedCount  = 0;
    const usedDoctorIds = new Set();

    // Exclude doctors already added to the CURRENT plan
    let currentPlan;
    if (noRepMode) {
      currentPlan = await prisma.monthlyPlan.findFirst({
        where: { id: parseInt(qPlanId), userId },
        include: { entries: { select: { doctorId: true } } },
      });
    } else {
      currentPlan = await prisma.monthlyPlan.findFirst({
        where: { scientificRepId: repId, month: m, year: y, userId },
        include: { entries: { select: { doctorId: true } } },
      });
    }
    if (currentPlan) {
      currentPlan.entries.forEach(e => usedDoctorIds.add(e.doctorId));
    }

    // Get scientific rep areas first (needed for both keepDoctors and newDoctors filtering)
    // ALWAYS prefer planAreas if the plan has them, regardless of whether there's a rep
    let areaIds;
    let repLinkedUserId = null;
    let doctorUserId;

    // Check plan-level areas first (from planAreas relation)
    let planAreaIdsFromDb = planAreaIds; // already loaded for noRepMode
    if (!noRepMode && qPlanId) {
      const pa = await prisma.planArea.findMany({ where: { planId: parseInt(qPlanId) }, select: { areaId: true } });
      planAreaIdsFromDb = pa.map(a => a.areaId);
    }

    if (planAreaIdsFromDb.length > 0) {
      // Plan has explicit areas — use them
      areaIds = planAreaIdsFromDb;
      if (!noRepMode && repId) {
        const repRecord = await prisma.scientificRepresentative.findUnique({
          where: { id: repId },
          select: { userId: true },
        });
        repLinkedUserId = repRecord?.userId ?? null;
        doctorUserId = repLinkedUserId ?? userId;
      } else {
        doctorUserId = userId;
      }
    } else if (noRepMode) {
      areaIds = [];
      doctorUserId = userId;
    } else {
      // Fall back to rep areas
      let repAreas = await prisma.scientificRepArea.findMany({
        where: { scientificRepId: repId },
        select: { areaId: true },
      });
      areaIds = repAreas.map(a => a.areaId);

      const repRecord = await prisma.scientificRepresentative.findUnique({
        where: { id: repId },
        select: { userId: true },
      });
      repLinkedUserId = repRecord?.userId ?? null;

      if (areaIds.length === 0 && repLinkedUserId) {
        const userAreas = await prisma.userAreaAssignment.findMany({
          where: { userId: repLinkedUserId },
          select: { areaId: true },
        });
        areaIds = userAreas.map(a => a.areaId);
      }

      doctorUserId = repLinkedUserId ?? userId;
    }

    const areaIdSet = new Set(areaIds);

    // Merge entries from all lookback plans (newest first → most recent feedback wins)
    const seenDoctorInPrev = new Map(); // doctorId → { doctor, visits[] }
    for (const plan of prevPlans) {
      for (const entry of plan.entries) {
        if (!seenDoctorInPrev.has(entry.doctor.id)) {
          seenDoctorInPrev.set(entry.doctor.id, { doctor: entry.doctor, visits: entry.visits });
        }
      }
    }

    for (const { doctor, visits } of seenDoctorInPrev.values()) {
      if (usedDoctorIds.has(doctor.id)) continue;
      // If area restriction is active, skip doctors not in the rep's assigned areas
      // Note: doctors with areaId=null (no area set) are excluded when restriction is on
      if (useAreaRestriction && areaIds.length > 0 && !areaIdSet.has(doctor.areaId)) continue;
      const lastFeedback = visits[0]?.feedback ?? 'pending';
      if (KEEP_FEEDBACK.includes(lastFeedback)) {
        keepDoctors.push({ doctor, reason: lastFeedback });
        usedDoctorIds.add(doctor.id);
      } else if (analyzeNotes) {
        const allNotes = normalizeAr(visits.map(v => v.notes ?? '').join(' '));
        if (allNotes.trim() && POSITIVE_NOTE_RE.test(allNotes)) {
          keepDoctors.push({ doctor, reason: 'positive_notes' });
          usedDoctorIds.add(doctor.id);
        } else { replacedCount++; }
      } else { replacedCount++; }
    }

    // ── Process userNote with Gemini AI ──────────────────────
    let priorityDoctors = [];
    let aiAreaOverride  = null; // null = use rep areas, [] = no restriction, [ids] = AI-specified
    let aiParsed        = null;
    const noteText      = String(userNote).trim();

    if (noteText) {
      try {
        const apiKey = getGeminiApiKey();
        if (apiKey) {
          const { GoogleGenerativeAI } = await import('@google/generative-ai');
          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
          const prompt = `أنت مساعد لبناء خطة زيارات شهرية لمندوب طبي.
المستخدم كتب التعليمات التالية:
"${noteText}"

حلل هذه التعليمات فقط واستخرج JSON (بدون markdown) بهذا الشكل الدقيق:
{
  "includeDoctorNames": [],
  "excludeDoctorNames": [],
  "includeAreaNames": [],
  "excludeAreaNames": [],
  "specialties": [],
  "summary": "ملخص قصير لما فهمته بالعربي"
}
- includeDoctorNames: أسماء أطباء يريد إضافتهم أو تضمينهم
- excludeDoctorNames: أسماء أطباء يريد استبعادهم
- includeAreaNames: مناطق يريد التركيز عليها
- excludeAreaNames: مناطق يريد تجنبها
- specialties: تخصصات طبية يريد التركيز عليها
أخرج JSON فقط بدون أي نص إضافي.`;
          const result = await model.generateContent(prompt);
          const raw = result.response.text().trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
          aiParsed = JSON.parse(raw);
        }
      } catch (e) {
        console.error('[suggest] AI note parsing failed:', e.message);
      }

      if (aiParsed) {
        // 1. Find doctors to include by name
        if (aiParsed.includeDoctorNames?.length) {
          const nameFilters = aiParsed.includeDoctorNames
            .map(n => String(n).replace(/^[دد]\.\s*/u, '').trim())
            .filter(Boolean)
            .map(n => ({ name: { contains: n } }));
          if (nameFilters.length) {
            const found = await prisma.doctor.findMany({
              where: { userId, isActive: true, OR: nameFilters },
              include: { area: { select: { id: true, name: true } }, targetItem: { select: { id: true, name: true } } },
            });
            found.forEach(d => {
              if (!usedDoctorIds.has(d.id)) {
                priorityDoctors.push(d);
                usedDoctorIds.add(d.id);
              }
            });
          }
        }

        // 2. Find doctors to exclude by name
        if (aiParsed.excludeDoctorNames?.length) {
          const exFilters = aiParsed.excludeDoctorNames
            .map(n => String(n).replace(/^[دد]\.\s*/u, '').trim())
            .filter(Boolean)
            .map(n => ({ name: { contains: n } }));
          if (exFilters.length) {
            const toExclude = await prisma.doctor.findMany({
              where: { userId, OR: exFilters }, select: { id: true },
            });
            toExclude.forEach(d => usedDoctorIds.add(d.id));
          }
        }

        // Arabic normalization for area name matching (handles ة/ه, أإآ/ا, ى/ي)
        const normAreaKey = s => String(s ?? '').trim().toLowerCase()
          .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
          .replace(/[ًٌٍَُِّْ]/g, '');

        // 3. Resolve AI-specified include areas (normalized match across all areas)
        if (aiParsed.includeAreaNames?.length) {
          const allAreasAI = await prisma.area.findMany({ select: { id: true, name: true } });
          const normInputs = new Set(aiParsed.includeAreaNames.map(normAreaKey));
          aiAreaOverride = allAreasAI.filter(a => normInputs.has(normAreaKey(a.name))).map(a => a.id);
        }

        // 4. Resolve AI-specified exclude areas (normalized match across all areas)
        if (aiParsed.excludeAreaNames?.length) {
          const allAreasEx = await prisma.area.findMany({ select: { id: true, name: true } });
          const normExInputs = new Set(aiParsed.excludeAreaNames.map(normAreaKey));
          const exAreaIds = new Set(allAreasEx.filter(a => normExInputs.has(normAreaKey(a.name))).map(a => a.id));
          // Exclude already-kept doctors from those areas
          keepDoctors = keepDoctors.filter(k => !exAreaIds.has(k.doctor.areaId));
          if (aiAreaOverride === null) {
            // Build area list = rep areas minus excluded
            aiAreaOverride = areaIds.filter(id => !exAreaIds.has(id));
          } else {
            aiAreaOverride = aiAreaOverride.filter(id => !exAreaIds.has(id));
          }
        }
      }
    }

    // ── Wished doctors (قائمة الطلبات) — always included regardless of area restriction ──
    const wishedIds = String(wishedDoctorIds).trim()
      ? String(wishedDoctorIds).split(',').map(s => parseInt(s.trim())).filter(n => Number.isInteger(n) && n > 0)
      : [];
    if (wishedIds.length > 0) {
      const toFind = wishedIds.filter(id => !usedDoctorIds.has(id));
      if (toFind.length > 0) {
        const wishedDocs = await prisma.doctor.findMany({
          where: { userId, isActive: true, id: { in: toFind } },
          include: {
            area:       { select: { id: true, name: true } },
            targetItem: { select: { id: true, name: true } },
          },
        });
        // Put wished doctors at the front of priorityDoctors
        priorityDoctors = [
          ...wishedDocs.map(d => ({ ...d, fromWishList: true })),
          ...priorityDoctors,
        ];
        wishedDocs.forEach(d => usedDoctorIds.add(d.id));
      }
    }

    // Determine the area filter for newDoctors
    // focusAreaId may be comma-separated (multiple area IDs)
    const focusAreaIds = String(focusAreaId).trim()
      ? String(focusAreaId).split(',').map(s => parseInt(s.trim())).filter(n => Number.isInteger(n) && n > 0)
      : [];
    const effectiveAreaIds = focusAreaIds.length > 0
      ? focusAreaIds
      : aiAreaOverride !== null
        ? aiAreaOverride
        : (useAreaRestriction && areaIds.length > 0 ? areaIds : []);

    // Parse areaQuotas: JSON like '{"1":10,"4":5}' — per-area doctor count
    const parsedAreaQuotas = (() => {
      const raw = String(areaQuotas ?? '').trim();
      if (!raw) return null;
      try {
        const q = JSON.parse(raw);
        if (typeof q === 'object' && q !== null && !Array.isArray(q)) return q;
        return null;
      } catch { return null; }
    })();

    // forcedNewRatio: 0 = auto, >0 = force % of total target as new doctors
    const forcedNewRatio = Math.max(0, Math.min(100, parseInt(newRatio) || 0));
    const forcedNewCount = forcedNewRatio > 0 ? Math.round(target * forcedNewRatio / 100) : null;
    const needed = parsedAreaQuotas
      ? Object.values(parsedAreaQuotas).reduce((s, v) => s + Math.max(0, parseInt(v) || 0), 0)
      : forcedNewCount !== null
        ? Math.max(0, forcedNewCount - priorityDoctors.length)
        : Math.max(0, target - keepDoctors.length - priorityDoctors.length);

    // specialty & item filters (both may be comma-separated for multi-select)
    const focusSpecialtyList = String(focusSpecialty).trim()
      ? String(focusSpecialty).split(',').map(s => s.trim()).filter(Boolean)
      : null;
    const specialtyFilter = focusSpecialtyList?.length
      ? focusSpecialtyList
      : (aiParsed?.specialties?.length ? aiParsed.specialties : null);
    const focusItemIds = String(focusItemId).trim()
      ? String(focusItemId).split(',').map(s => parseInt(s.trim())).filter(n => Number.isInteger(n) && n > 0)
      : [];
    const itemFilter = focusItemIds.length > 0 ? { targetItemId: { in: focusItemIds } } : {};

    // إذا كان منشئ البلان (userId) مختلفاً عن userId المندوب (doctorUserId)،
    // نبحث في قاعدة بيانات الطرفين معاً (المندوب + المدير) بنفس فلتر المناطق.
    const doctorUserFilter = (doctorUserId !== userId)
      ? { userId: { in: [doctorUserId, userId] } }
      : { userId: doctorUserId };

    let newDoctors = [];

    if (parsedAreaQuotas && Object.keys(parsedAreaQuotas).length > 0) {
      // ── Per-area quota fetch with proportional scaling ─────────────────────
      // The user-entered quotas define RATIOS. They are always scaled so the
      // total equals `target` (targetDoctors). This means:
      //   - If user entered 30 across areas but target=40 → scale up by 40/30
      //   - If user entered 50 across areas but target=40 → scale down by 40/50
      const rawEntries = Object.entries(parsedAreaQuotas)
        .map(([id, v]) => ({ id: parseInt(id), raw: Math.max(0, parseInt(v) || 0) }))
        .filter(x => !isNaN(x.id) && x.raw > 0);

      const quotaTotal = rawEntries.reduce((s, x) => s + x.raw, 0);

      if (quotaTotal > 0) {
        // Scale proportionally to target
        const scaled = rawEntries.map(x => ({
          id:    x.id,
          quota: Math.round(x.raw / quotaTotal * target),
        }));

        // Fix rounding drift: distribute difference to largest-quota areas first
        let scaledSum = scaled.reduce((s, x) => s + x.quota, 0);
        let diff = target - scaledSum;
        const sortedIdx = [...scaled.keys()].sort((a, b) => scaled[b].quota - scaled[a].quota);
        for (let i = 0; Math.abs(diff) > 0 && i < sortedIdx.length; i++) {
          const step = diff > 0 ? 1 : -1;
          scaled[sortedIdx[i]].quota += step;
          diff -= step;
        }

        for (const { id: aId, quota: scaledQuota } of scaled) {
          if (scaledQuota <= 0) continue;

          // Deduct doctors already kept from this area
          const keptFromArea = keepDoctors.filter(k => k.doctor.areaId === aId).length
            + priorityDoctors.filter(d => d.areaId === aId).length;
          const newNeeded = Math.max(0, scaledQuota - keptFromArea);
          if (newNeeded === 0) continue;

          const fetchCount = sortBy === 'random' ? Math.min(newNeeded * 4, 500) : newNeeded;
          let areaDocs = await prisma.doctor.findMany({
            where: {
              ...doctorUserFilter,
              isActive: true,
              id: { notIn: [...usedDoctorIds] },
              areaId: aId,
              ...(specialtyFilter && { specialty: { in: specialtyFilter } }),
              ...itemFilter,
            },
            include: {
              area:       { select: { id: true, name: true } },
              targetItem: { select: { id: true, name: true } },
            },
            take: fetchCount,
            orderBy: sortBy === 'newest' ? { createdAt: 'desc' } : { createdAt: 'asc' },
          });
          if (sortBy === 'random') areaDocs = areaDocs.sort(() => Math.random() - 0.5).slice(0, newNeeded);
          areaDocs.forEach(d => usedDoctorIds.add(d.id));
          newDoctors.push(...areaDocs);
        }
      }
    } else if (needed > 0) {
      // ── Bulk fetch (original logic) ──────────────────────────
      const fetchCount = sortBy === 'random' ? Math.min(needed * 4, 500) : needed;
      newDoctors = await prisma.doctor.findMany({
        where: {
          ...doctorUserFilter,
          isActive: true,
          id: { notIn: [...usedDoctorIds] },
          ...(effectiveAreaIds.length > 0 && { areaId: { in: effectiveAreaIds } }),
          ...(specialtyFilter && { specialty: { in: specialtyFilter } }),
          ...itemFilter,
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
      newDoctors: [...priorityDoctors, ...newDoctors],
      aiNote: noteText
        ? { raw: noteText, parsed: aiParsed ?? undefined }
        : null,
      summary: {
        keep:    keepDoctors.length,
        replace: replacedCount,
        new:     priorityDoctors.length + newDoctors.length,
        total:   keepDoctors.length + priorityDoctors.length + newDoctors.length,
      },
    });
  } catch (e) { next(e); }
}

// ── Get rep areas for suggest quota UI ───────────────────────
export async function suggestAreas(req, res, next) {
  try {
    const { scientificRepId } = req.query;
    if (!scientificRepId) return res.status(400).json({ error: 'scientificRepId مطلوب' });

    const repId = parseInt(scientificRepId);

    const repRecord = await prisma.scientificRepresentative.findUnique({
      where: { id: repId },
      select: { userId: true },
    });
    const repLinkedUserId = repRecord?.userId ?? null;

    // Primary: ScientificRepArea
    let repAreaRows = await prisma.scientificRepArea.findMany({
      where: { scientificRepId: repId },
      select: { areaId: true },
    });
    let areaIds = repAreaRows.map(a => a.areaId);

    // Fallback: UserAreaAssignment
    if (areaIds.length === 0 && repLinkedUserId) {
      const userAreas = await prisma.userAreaAssignment.findMany({
        where: { userId: repLinkedUserId },
        select: { areaId: true },
      });
      areaIds = userAreas.map(a => a.areaId);
    }

    if (areaIds.length === 0) return res.json([]);

    const areas = await prisma.area.findMany({
      where: { id: { in: areaIds } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(areas);
  } catch (e) { next(e); }
}

// ── Create plan ───────────────────────────────────────────────
export async function create(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const REP_ROLES_C = new Set(['user','scientific_rep','team_leader','supervisor','commercial_rep']);
    const MANAGER_ROLES = new Set(['admin','manager','company_manager','supervisor','product_manager','team_leader','office_manager']);
    let { scientificRepId, month, year, targetCalls, targetDoctors, notes, doctorIds, areaIds } = req.body;

    // Reps can only create plans for themselves (their linkedRepId)
    if (REP_ROLES_C.has(role)) {
      const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      if (!dbUser?.linkedRepId)
        return res.status(400).json({ error: 'حسابك غير مرتبط بمندوب علمي. تواصل مع المدير.' });
      scientificRepId = dbUser.linkedRepId;
    }

    // Managers can create without a rep, but must provide areas
    if (MANAGER_ROLES.has(role) && !scientificRepId) {
      if (!areaIds || !areaIds.length)
        return res.status(400).json({ error: 'يجب تحديد المناطق عند إنشاء بلان بدون مندوب.' });
    }

    // For reps, repId is required
    if (!MANAGER_ROLES.has(role) && !scientificRepId)
      return res.status(400).json({ error: 'الحقول المطلوبة: scientificRepId, month, year' });
    if (!month || !year)
      return res.status(400).json({ error: 'الحقول المطلوبة: month, year' });

    const plan = await prisma.monthlyPlan.create({
      data: {
        scientificRepId: scientificRepId ? parseInt(scientificRepId) : null,
        month: parseInt(month),
        year:  parseInt(year),
        targetCalls:   targetCalls   ? parseInt(targetCalls)   : (doctorIds?.length ? doctorIds.length * 2 : 150),
        targetDoctors: targetDoctors ? parseInt(targetDoctors) : (doctorIds?.length ?? 75),
        notes,
        userId,
        entries: doctorIds?.length ? {
          create: doctorIds.map(id => ({ doctorId: parseInt(id), targetVisits: 2 })),
        } : undefined,
        planAreas: areaIds?.length ? {
          create: areaIds.map(id => ({ areaId: parseInt(id) })),
        } : undefined,
      },
      include: {
        scientificRep: { select: { id: true, name: true } },
        entries: { include: { doctor: true } },
        planAreas: { include: { area: { select: { id: true, name: true } } } },
      },
    });
    res.status(201).json(plan);
  } catch (e) { next(e); }
}

// ── Update plan ───────────────────────────────────────────────
export async function update(req, res, next) {
  try {
    const { notes, status, targetCalls, targetDoctors, allowExtraVisits, scientificRepId } = req.body;
    const result = await prisma.monthlyPlan.updateMany({
      where: { id: parseInt(req.params.id), OR: [{ userId: req.user.id }, { assignedUserId: req.user.id }] },
      data: {
        ...(notes             !== undefined && { notes }),
        ...(status            !== undefined && { status }),
        ...(targetCalls       !== undefined && { targetCalls:       parseInt(targetCalls) }),
        ...(targetDoctors     !== undefined && { targetDoctors:     parseInt(targetDoctors) }),
        ...(allowExtraVisits  !== undefined && { allowExtraVisits:  Boolean(allowExtraVisits) }),
        ...(scientificRepId   !== undefined && { scientificRepId:   scientificRepId ? parseInt(scientificRepId) : null }),
      },
    });
    if (result.count === 0) return res.status(404).json({ error: 'غير موجود' });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Delete plan ───────────────────────────────────────────────
export async function remove(req, res, next) {
  try {
    const result = await prisma.monthlyPlan.deleteMany({
      where: { id: parseInt(req.params.id), OR: [{ userId: req.user.id }, { assignedUserId: req.user.id }] },
    });
    if (result.count === 0) return res.status(404).json({ error: 'غير موجود' });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Add doctor entry to plan ──────────────────────────────────
export async function addEntry(req, res, next) {
  try {
    const planId   = parseInt(req.params.id);
    const { doctorId, targetVisits, isExtraVisit } = req.body;

    // Verify plan belongs to user (only owners can add entries)
    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    const entry = await prisma.planEntry.create({
      data: { planId, doctorId: parseInt(doctorId), targetVisits: targetVisits ?? 2, isExtraVisit: Boolean(isExtraVisit) },
      include: { doctor: { include: { area: true, targetItem: true } } },
    });
    await recalcTargetCalls(planId);
    res.status(201).json(entry);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'الطبيب مضاف مسبقاً في البلان' });
    next(e);
  }
}

// ── Remove doctor entry from plan ────────────────────────────
export async function removeEntry(req, res, next) {
  try {
    const planId   = parseInt(req.params.id);
    const entryId  = parseInt(req.params.entryId);

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    await prisma.planEntry.delete({ where: { id: entryId } });
    await recalcTargetCalls(planId);
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Bulk remove entries from plan ────────────────────────────
export async function bulkRemoveEntries(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const { entryIds } = req.body;           // number[]

    if (!Array.isArray(entryIds) || entryIds.length === 0)
      return res.status(400).json({ error: 'entryIds مطلوب' });

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    const ids = entryIds.map(Number).filter(n => !isNaN(n));

    const result = await prisma.planEntry.deleteMany({
      where: { id: { in: ids }, planId },
    });
    await recalcTargetCalls(planId);
    res.json({ success: true, deleted: result.count });
  } catch (e) { next(e); }
}

export async function patchEntry(req, res, next) {
  try {
    const planId  = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const { targetVisits } = req.body;

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    const entry = await prisma.planEntry.update({
      where: { id: entryId },
      data:  { targetVisits: parseInt(targetVisits) },
    });
    await recalcTargetCalls(planId);
    res.json(entry);
  } catch (e) { next(e); }
}

// ── Add item to plan entry ────────────────────────────────────
export async function addEntryItem(req, res, next) {
  try {
    const planId  = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId مطلوب' });

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    const record = await prisma.planEntryItem.create({
      data: { planEntryId: entryId, itemId: parseInt(itemId) },
      include: { item: { select: { id: true, name: true } } },
    });
    res.status(201).json(record);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'الايتم مضاف مسبقاً' });
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
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

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
    const { visitDate, itemId, itemName, feedback, notes, latitude, longitude, isDoubleVisit } = req.body;

    // ── requireGps check ──────────────────────────────────────
    const _u = await prisma.user.findUnique({ where: { id: userId }, select: { permissions: true } });
    try { const _p = JSON.parse(_u?.permissions || '{}'); if (_p.requireGps !== false && latitude == null) return res.status(400).json({ error: 'يجب تفعيل الموقع الجغرافي لإرسال هذا التقرير' }); } catch {}

    const plan = await findAccessiblePlan(planId, userId, role);
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    const entry = await prisma.planEntry.findFirst({ where: { id: entryId, planId } });
    if (!entry) return res.status(404).json({ error: 'الإدخال غير موجود' });

    // Resolve itemId: if not provided, look up by name among user/rep items
    let resolvedItemId = itemId ? parseInt(itemId) : null;
    if (!resolvedItemId && itemName && String(itemName).trim()) {
      const rawName = String(itemName).trim();
      const normalize = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      const n = normalize(rawName);
      // Fetch items accessible to this user
      let candidateItems;
      if (['scientific_rep', 'team_leader', 'supervisor'].includes(role)) {
        const rep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
        if (rep) {
          const ri = await prisma.scientificRepItem.findMany({ where: { scientificRepId: rep.id }, include: { item: { select: { id: true, name: true } } } });
          candidateItems = ri.map(r => r.item);
        } else { candidateItems = []; }
      } else {
        candidateItems = await prisma.item.findMany({ where: { userId }, select: { id: true, name: true } });
      }
      // Fuzzy match: exact first, then contains
      let matched = candidateItems.find(it => normalize(it.name) === n);
      if (!matched) matched = candidateItems.find(it => normalize(it.name).includes(n) || n.includes(normalize(it.name)));
      if (matched) { resolvedItemId = matched.id; }

      // Still no match — upsert the item so the free-text name is never lost
      if (!resolvedItemId) {
        const upserted = await prisma.item.upsert({
          where: { name_userId: { name: rawName, userId } },
          create: { name: rawName, userId },
          update: {},
          select: { id: true },
        });
        resolvedItemId = upserted.id;
        // Link the new item to the scientific rep so it appears in future suggestions
        if (['scientific_rep', 'team_leader', 'supervisor'].includes(role)) {
          const repRow = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
          if (repRow) {
            await prisma.scientificRepItem.upsert({
              where: { scientificRepId_itemId: { scientificRepId: repRow.id, itemId: resolvedItemId } },
              create: { scientificRepId: repRow.id, itemId: resolvedItemId },
              update: {},
            });
          }
        }
      }
    }

    const visit = await prisma.doctorVisit.create({
      data: {
        doctorId:        entry.doctorId,
        scientificRepId: plan.scientificRepId,
        planEntryId:     entryId,
        visitDate:       visitDate ? new Date(visitDate) : new Date(),
        itemId:          resolvedItemId,
        feedback:        feedback ?? 'pending',
        notes:           notes ?? '',
        isDoubleVisit:   isDoubleVisit === true || isDoubleVisit === 'true',
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
    const visit = await prisma.doctorVisit.findUnique({ where: { id: visitId } });
    if (!visit) return res.status(404).json({ error: 'الزيارة غير موجودة' });
    await prisma.doctorVisit.delete({ where: { id: visitId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Update visit item ────────────────────────────────────────────
export async function patchVisitItem(req, res, next) {
  try {
    const visitId = parseInt(req.params.visitId);
    const { itemId } = req.body;

    const visit = await prisma.doctorVisit.findUnique({ where: { id: visitId } });
    if (!visit) return res.status(404).json({ error: 'الزيارة غير موجودة' });

    const updated = await prisma.doctorVisit.update({
      where: { id: visitId },
      data:  { itemId: itemId ? parseInt(itemId) : null },
      include: { item: { select: { id: true, name: true } } },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

// ── Toggle like on a visit (managers/admins only) ────────────
export async function toggleVisitLike(req, res, next) {
  try {
    const userId  = req.user.id;
    const visitId = parseInt(req.params.visitId);
    const existing = await prisma.visitLike.findUnique({ where: { visitId_userId: { visitId, userId } } });
    if (existing) {
      await prisma.visitLike.delete({ where: { visitId_userId: { visitId, userId } } });
      const likes = await prisma.visitLike.findMany({ where: { visitId }, select: { id: true, userId: true, user: { select: { id: true, username: true } } } });
      return res.json({ liked: false, likes });
    }
    await prisma.visitLike.create({ data: { visitId, userId } });
    const likes = await prisma.visitLike.findMany({ where: { visitId }, select: { id: true, userId: true, user: { select: { id: true, username: true } } } });
    res.json({ liked: true, likes });
  } catch (e) { next(e); }
}

// ── Add manager comment on a visit ───────────────────────────
export async function addVisitComment(req, res, next) {
  try {
    const userId  = req.user.id;
    const visitId = parseInt(req.params.visitId);
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'المحتوى مطلوب' });

    const comment = await prisma.visitComment.create({
      data: { visitId, userId, content: content.trim() },
      select: { id: true, visitId: true, userId: true, content: true, createdAt: true, user: { select: { id: true, username: true } } },
    });
    res.json(comment);
  } catch (e) { next(e); }
}

// ── Delete manager comment ────────────────────────────────────
export async function deleteVisitComment(req, res, next) {
  try {
    const userId    = req.user.id;
    const commentId = parseInt(req.params.commentId);
    const comment   = await prisma.visitComment.findUnique({ where: { id: commentId } });
    if (!comment) return res.status(404).json({ error: 'التعليق غير موجود' });
    if (comment.userId !== userId) return res.status(403).json({ error: 'غير مسموح' });
    await prisma.visitComment.delete({ where: { id: commentId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Import plan entries (doctors list) from JSON sent by frontend ──────────
export async function importPlanEntries(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const { entries } = req.body; // [{ name: string, targetVisits?: number }]
    if (!Array.isArray(entries) || entries.length === 0)
      return res.status(400).json({ error: 'مصفوفة entries مطلوبة' });

    const { id: userId, role } = req.user;
    const plan = await findAccessiblePlan(planId, userId, role);
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    // Get already-added entry doctor IDs to skip duplicates
    const existing = await prisma.planEntry.findMany({
      where: { planId },
      select: { doctorId: true },
    });
    const existingIds = new Set(existing.map(e => e.doctorId));

    // Fetch accessible doctors
    const FIELD_ROLES = ['user','scientific_rep','supervisor','team_leader','commercial_rep'];
    let doctors;
    if (FIELD_ROLES.includes(role)) {
      const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      doctors = await prisma.doctor.findMany({
        where: { OR: [{ userId }, { scientificRepId: userRow?.linkedRepId ?? -1 }] },
        select: { id: true, name: true },
      });
    } else {
      // Admin / manager — search all doctors
      doctors = await prisma.doctor.findMany({ select: { id: true, name: true } });
    }

    const normalize = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

    const imported = [];
    const unmatched = [];

    for (const row of entries) {
      if (!row.name?.trim()) continue;
      const n = normalize(row.name);
      // Exact match first, then partial
      let matched = doctors.find(d => normalize(d.name) === n);
      if (!matched) matched = doctors.find(d => normalize(d.name).includes(n) || n.includes(normalize(d.name)));
      if (!matched || existingIds.has(matched.id)) {
        if (!matched) unmatched.push(row.name.trim());
        continue;
      }
      await prisma.planEntry.create({
        data: { planId, doctorId: matched.id, targetVisits: Number(row.targetVisits) || 2 },
      });
      existingIds.add(matched.id);
      imported.push(matched.name);
    }

    res.json({ imported: imported.length, total: entries.length, unmatched, importedNames: imported });
    // recalculate targets after bulk import
    if (imported.length > 0) await recalcTargetCalls(planId);
  } catch (e) { next(e); }
}

// ── Import visits from Excel — linked to a specific plan ─────
// Accepts any column order / naming — smart fuzzy column detection
export async function importPlanVisits(req, res, next) {
  try {
    const userId = req.user.id;
    const planId = parseInt(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع أي ملف' });

    // Load the plan with entries + doctors (accessible by owner or assigned rep)
    const role = req.user.role;
    const planBase = await findAccessiblePlan(planId, userId, role);
    if (!planBase) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'البلان غير موجود' }); }
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

      if (!doctorName) { errors.push({ row: i + 2, error: 'اسم الطبيب فارغ' }); continue; } // already Arabic

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
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع أي ملف' });

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
        errors.push({ row: i + 2, error: 'حقول مطلوبة مفقودة' });
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
      if (!rep) { errors.push({ row: i + 2, error: `المندوب غير موجود: ${repName}` }); continue; }

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
        errors.push({ row: i + 2, error: `تاريخ غير صحيح: ${visitDate}` });
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
    if (!planAccess) return res.status(404).json({ error: 'البلان غير موجود' });

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
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    const allItems = await prisma.item.findMany({ where: { userId }, select: { id: true, name: true } });

    const doctorNames = plan.entries.map(e => `${e.doctor.name} (id:${e.id})`).join('\n');
    const itemNames = allItems.map(i => `${i.name} (id:${i.id})`).join('\n');

    const feedbackValues = ['writing', 'stocked', 'interested', 'not_interested', 'unavailable', 'pending'];
    const feedbackAr = {
      'يكتب': 'writing', 'كاتب': 'writing', 'بلش يكتب': 'writing', 'اشترى': 'writing', 'طلب': 'writing',
      'نزل': 'stocked', 'نزل الايتم': 'stocked', 'عنده منافس': 'stocked', 'كومبتتر': 'stocked', 'يستخدم منتج ثاني': 'stocked', 'عنده بديل': 'stocked',
      'مهتم': 'interested', 'مهتمه': 'interested', 'ايجابي': 'interested', 'متحمس': 'interested',
      'غير مهتم': 'not_interested', 'مو مهتم': 'not_interested', 'رفض': 'not_interested', 'ما يريد': 'not_interested',
      'غير متوفر': 'unavailable', 'مو موجود': 'unavailable', 'معلق': 'unavailable', 'غداً': 'unavailable', 'متابعة': 'unavailable', 'تذكير': 'unavailable', 'موعد ثاني': 'unavailable',
      'بانتظار الفيدباك': 'pending', 'انتظار': 'pending',
    };

    const prompt = `أنت مساعد ذكي لتحليل كلام مندوب طبي. المندوب يتكلم عن زيارات قام بها لأطباء.

  قائمة الأطباء في البلان (اسم الطبيب و entry id):
  ${doctorNames}

  قائمة الأيتمات/الأدوية المتاحة (اكتب اسم الدواء كما هو بالضبط من القائمة فقط، ولا تخترع أسماء جديدة):
  ${itemNames}

  قيم الفيدباك المتاحة: ${feedbackValues.join(', ')}
  قواعد استنتاج الفيدباك من الكلام الطبيعي — استنتج من المعنى حتى لو لم تُستخدم الكلمة الدقيقة:
  • writing (يكتب): "بلش يكتب"/"صار يكتب"/"اشترى"/"طلب"/"اشتغل على الإيتم"/"نزّل الدواء عنده" → writing
  • stocked (يوجد كومبتتر): "عنده منافس"/"يستخدم منتج ثاني"/"مو موالي"/"عنده بديل"/"ما يتغير"/"كومبتتر" → stocked
  • interested (مهتم): "عجبه"/"طلب معلومات أكثر"/"ايجابي"/"متحمس"/"شايف مصلحة"/"واعد" → interested
  • not_interested (غير مهتم): "ما عجبه"/"رفض"/"ما يريد"/"قال لا"/"يرفض"/"سلبي" → not_interested
  • unavailable (متابعة وتذكير): "غداً"/"بعدين"/"موعد ثاني"/"اتصل لاحقاً"/"تذكير"/"متابعة"/"رجع عليه"/"ما كان موجود" → unavailable
  • pending (بانتظار الفيدباك): لم تُذكر أي نتيجة أو ردة فعل واضحة → pending
  يمكن أن يكون الفيدباك قيمة واحدة أو مصفوفة من قيمتين إذا قال المستخدم اثنتين (مثل "يكتب ومهتم" → ["writing","interested"]).

  النص المنطوق:
  "${text}"

  حلل النص واستخرج كل زيارة مذكورة. لكل زيارة أرجع:
  - entryId: رقم الـ entry id للطبيب من القائمة أعلاه (طابق الاسم حتى لو كان منطوق بشكل مختلف قليلاً)
  - doctorName: اسم الطبيب كما ورد
  - itemId: رقم id الايتم (null إذا لم يُذكر)
  - itemName: اسم الايتم كما ورد (اكتبه كما هو من القائمة فقط)
  - feedback: قيمة الفيدباك من القائمة أعلاه — استنج من المعنى (pending إذا لم يُذكر). يمكن أن يكون string أو array من اثنتين.
  - notes: أي ملاحظات إضافية
  - date: التاريخ إذا ذُكر (YYYY-MM-DD) وإلا null

  مهم جداً: لا تكتب أي اسم دواء غير موجود في القائمة. إذا لم تتعرف على الدواء تجاهله أو اتركه فارغاً.

  أرجع JSON فقط بالشكل التالي بدون أي نص إضافي:
  {"visits": [{"entryId": 123, "doctorName": "...", "itemId": 456, "itemName": "...", "feedback": "writing", "notes": "", "date": null, "specialty": "", "pharmacyName": "", "areaName": ""}]}`;

    const apiKey = getGeminiApiKey();
    if (!apiKey) return res.status(500).json({ error: 'مفتاح Gemini غير مهيأ' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'تعذَّر تحليل النص', raw: responseText });

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
        feedback: Array.isArray(v.feedback)
          ? v.feedback.filter(f => feedbackValues.includes(f)).slice(0, 2).join(',') || 'pending'
          : (feedbackValues.includes(v.feedback) ? v.feedback : feedbackAr[v.feedback] && feedbackValues.includes(feedbackAr[v.feedback]) ? feedbackAr[v.feedback] : 'pending'),
        notes: v.notes || '',
        date: v.date || new Date().toISOString().split('T')[0],
      };
    });

    res.json({ visits, raw: text });
  } catch (e) {
    console.error('خطأ في تحليل النص الصوتي:', e);
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
    if (!planAccess) return res.status(404).json({ error: 'البلان غير موجود' });

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
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    // scientific_rep/team_leader/supervisor: items assigned via ScientificRepItem junction + assigned companies
    let allItems;
    if (['scientific_rep', 'team_leader', 'supervisor'].includes(role)) {
      const rep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
      if (rep) {
        const [repItemRows, repCompanyRows] = await Promise.all([
          prisma.scientificRepItem.findMany({
            where: { scientificRepId: rep.id },
            include: { item: { select: { id: true, name: true } } },
          }),
          prisma.scientificRepCompany.findMany({
            where: { scientificRepId: rep.id },
            select: { companyId: true },
          }),
        ]);
        const explicitItems = repItemRows.map(ri => ri.item);
        const companyIds = repCompanyRows.map(rc => rc.companyId);
        let companyItems = [];
        if (companyIds.length > 0) {
          companyItems = await prisma.item.findMany({
            where: { companyId: { in: companyIds } },
            select: { id: true, name: true },
          });
        }
        const seen = new Set();
        allItems = [...explicitItems, ...companyItems]
          .filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
      } else {
        allItems = [];
      }
    } else {
      allItems = await prisma.item.findMany({ where: { userId }, select: { id: true, name: true } });
    }

    const audioData   = fs.readFileSync(req.file.path);
    const audioBase64 = audioData.toString('base64');
    const mimeType    = req.file.mimetype || 'audio/webm';
    fs.unlinkSync(req.file.path); // cleanup

    const doctorNames   = plan.entries.map(e => `${e.doctor.name} (id:${e.id})`).join('\n');
    const itemNames     = allItems.map(i => `${i.name} (id:${i.id})`).join('\n');
    const feedbackValues = ['writing', 'stocked', 'interested', 'not_interested', 'unavailable', 'pending'];
    const feedbackAr = {
      'يكتب': 'writing', 'كاتب': 'writing', 'بلش يكتب': 'writing', 'اشترى': 'writing', 'طلب': 'writing',
      'نزل': 'stocked', 'نزل الايتم': 'stocked', 'عنده منافس': 'stocked', 'كومبتتر': 'stocked', 'يستخدم منتج ثاني': 'stocked', 'عنده بديل': 'stocked',
      'مهتم': 'interested', 'مهتمه': 'interested', 'ايجابي': 'interested', 'متحمس': 'interested',
      'غير مهتم': 'not_interested', 'مو مهتم': 'not_interested', 'رفض': 'not_interested', 'ما يريد': 'not_interested',
      'غير متوفر': 'unavailable', 'مو موجود': 'unavailable', 'معلق': 'unavailable', 'غداً': 'unavailable', 'متابعة': 'unavailable', 'تذكير': 'unavailable', 'موعد ثاني': 'unavailable',
      'بانتظار الفيدباك': 'pending', 'انتظار': 'pending',
    };

    const prompt = `أنت متخصص في تحويل التسجيلات الصوتية لمناديب المبيعات الطبية إلى بيانات منظمة.

══ القاعدة الذهبية ══
اكتب ما سمعته بالضبط — لا تستبدل أي اسم ولا تضف عليه ولا تعدله.

══ اسم الطبيب ══
• doctorName: اكتب اسم الطبيب بالضبط كما نُطق في التسجيل — لا تغيّره ولا تضف كلمات عليه ولا تعكس ترتيبه
• entryId: دائماً null

══ الأيتمات/الأدوية ══
• itemName: اكتب اسم الدواء أو الايتم كما نُطق في التسجيل
• itemId: أرجعه فقط إذا كنت متأكداً 100% أنه من القائمة أدناه — وإلا null
• كلمات الفيدباك (يكتب، مهتم، نزل...) لا تُعتبر أسماء أدوية

══ باقي الحقول ══
• feedback: ${feedbackValues.join(' | ')} — استنتج من المعنى حتى لو لم تُستخدم الكلمة الدقيقة:
  - writing (يكتب): "بلش يكتب" / "صار يكتب" / "اشترى" / "طلب" / "نزّل الدواء عنده"
  - stocked (يوجد كومبتتر): "عنده منافس" / "يستخدم منتج ثاني" / "عنده بديل" / "كومبتتر" / "مو موالي"
  - interested (مهتم): "عجبه" / "ايجابي" / "متحمس" / "طلب معلومات" / "واعد"
  - not_interested (غير مهتم): "ما عجبه" / "رفض" / "ما يريد" / "قال لا" / "سلبي"
  - unavailable (متابعة وتذكير): "غداً" / "بعدين" / "موعد ثاني" / "اتصل لاحقاً" / "ما كان موجود" / "تذكير" / "متابعة"
  - pending: لم تُذكر نتيجة أو ردة فعل واضحة
• يمكن أن يكون feedback قيمة واحدة أو مصفوفة من اثنتين إذا ذُكرت نتيجتان (مثل "يكتب ومهتم" → ["writing","interested"])
• إذا لم يُذكر فيدباك → feedback = "pending"
• specialty / pharmacyName / areaName: فقط إذا ذُكرت صراحةً — وإلا ""
• إذا التسجيل فارغ أو غير مفهوم → أرجع {"visits": []}

══ قائمة الأيتمات (للمساعدة في itemId فقط) ══
${itemNames || '(لا توجد أيتمات)'}

أرجع JSON فقط بدون أي نص آخر:
{"visits": [{"entryId": null, "doctorName": "الاسم كما نُطق", "itemId": null, "itemName": "الايتم كما نُطق", "feedback": "pending", "notes": "", "date": null, "specialty": "", "pharmacyName": "", "areaName": ""}]}`;

    const apiKey = getGeminiApiKey();
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

    // Arabic feedback words that must NEVER be treated as item/drug names
    const FEEDBACK_AR_SET = new Set(['مهتم','مهتمه','غير مهتم','مو مهتم','يكتب','كاتب','نزل','معلق','غير متوفر','مو موجود','بانتظار الفيدباك','انتظار','يوجد كومبتتر','متابعة','متابعه','تذكير']);
    const isFeedbackWord = name => FEEDBACK_AR_SET.has(String(name ?? '').trim());

    // Fuzzy item-matching: normalize + bigram similarity
    const normalize  = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const normAr2    = s => String(s ?? '').trim().toLowerCase().replace(/أ|إ|آ/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/\s+/g,' ');
    const itemMap    = new Map(allItems.map(it => [normalize(it.name), it]));
    const bigramSet2 = s => {
      const bg = new Set();
      for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2));
      return bg;
    };
    const bigramSim2 = (a, b) => {
      const na = normAr2(a), nb = normAr2(b);
      if (!na || !nb) return 0;
      if (na === nb) return 1;
      const ba = bigramSet2(na), bb = bigramSet2(nb);
      let shared = 0;
      for (const bg of ba) if (bb.has(bg)) shared++;
      return (2 * shared) / (ba.size + bb.size);
    };
    const findItem = (rawName) => {
      const n = normalize(rawName);
      const nn = normAr2(rawName);
      if (!n) return null;
      if (itemMap.has(n)) return itemMap.get(n);
      let f = allItems.find(i => normAr2(i.name) === nn);    if (f) return f;
      f = allItems.find(i => normAr2(i.name).includes(nn) || nn.includes(normAr2(i.name))); if (f) return f;
      const nnToks = nn.split(' ').filter(t => t.length >= 2);
      if (nnToks.length > 0) {
        f = allItems.find(i => nnToks.every(t => normAr2(i.name).includes(t)));
        if (f) return f;
      }
      let best = null, bestScore = 0.5;
      for (const [key, item] of itemMap) {
        const score = bigramSim2(rawName, item.name);
        if (score > bestScore) { bestScore = score; best = item; }
      }
      return best;
    };

    // entryId is always null — client handles doctor matching via fuzzy logic
    const visits = (parsed.visits || []).map(v => {
      let itemId = v.itemId || null;
      let itemName = v.itemName || '';
      // Guard: never treat a feedback word as an item name
      if (isFeedbackWord(itemName)) { itemId = null; itemName = ''; }
      if (itemName && (!itemId || !allItems.some(it => it.id === itemId))) {
        const match = findItem(itemName);
        if (match) { itemId = match.id; itemName = match.name; }
      }
      return {
        entryId:      null,            // always null — client does fuzzy matching
        doctorName:   v.doctorName    || '',
        itemId,
        itemName,
        feedback: Array.isArray(v.feedback)
          ? v.feedback.filter(f => feedbackValues.includes(f)).slice(0, 2).join(',') || 'pending'
          : (feedbackValues.includes(v.feedback) ? v.feedback : feedbackAr[v.feedback] && feedbackValues.includes(feedbackAr[v.feedback]) ? feedbackAr[v.feedback] : 'pending'),
        notes:        v.notes        || '',
        date:         v.date         || new Date().toISOString().split('T')[0],
        specialty:    v.specialty    || '',
        pharmacyName: v.pharmacyName || '',
        areaName:     v.areaName     || '',
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
// ── Get users eligible to receive a plan transfer ──────────────────────────
// GET /api/monthly-plans/:id/transfer-targets
export async function getTransferTargets(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const plan = await prisma.monthlyPlan.findUnique({
      where: { id: planId },
      select: { scientificRepId: true, userId: true },
    });
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود.' });

    // Find users linked via linkedRepId OR via ScientificRepresentative.userId
    const [byLinkedRepId, repRecord] = await Promise.all([
      prisma.user.findMany({
        where: { linkedRepId: plan.scientificRepId, isActive: true },
        select: { id: true, username: true, displayName: true, role: true, linkedRepId: true },
      }),
      prisma.scientificRepresentative.findUnique({
        where: { id: plan.scientificRepId },
        select: { userId: true },
      }),
    ]);

    let users = [...byLinkedRepId];
    if (repRecord?.userId && !users.find(u => u.id === repRecord.userId)) {
      const repUser = await prisma.user.findUnique({
        where: { id: repRecord.userId, isActive: true },
        select: { id: true, username: true, displayName: true, role: true, linkedRepId: true },
      });
      if (repUser) users.push(repUser);
    }

    res.json({ success: true, data: users });
  } catch (e) { next(e); }
}

// ── Get doctors available to add to a plan (not currently in entries) ──
export async function availableDoctors(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const { q }  = req.query;
    const { id: userId, role } = req.user;

    const plan = await findAccessiblePlan(planId, userId, role);
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    const usedIds = (await prisma.planEntry.findMany({
      where:  { planId },
      select: { doctorId: true },
    })).map(e => e.doctorId);

    // Check if plan has planAreas — use them for area filtering
    const planAreaRows = await prisma.planArea.findMany({ where: { planId }, select: { areaId: true } });
    const planAreaIds = planAreaRows.map(a => a.areaId);

    // For field reps: restrict to their assigned areas only
    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    let areaFilter = {};
    if (planAreaIds.length > 0) {
      // Plan has explicit areas — use them (overrides rep area filter)
      areaFilter = { areaId: { in: planAreaIds } };
    } else if (FIELD_ROLES.includes(role)) {
      const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      const linkedRepId = dbUser?.linkedRepId ?? null;
      const [userAreaRows, repAreaRows] = await Promise.all([
        prisma.userAreaAssignment.findMany({ where: { userId }, select: { areaId: true } }),
        linkedRepId
          ? prisma.scientificRepArea.findMany({ where: { scientificRepId: linkedRepId }, select: { areaId: true } })
          : Promise.resolve([]),
      ]);
      const repAreaIds = [...new Set([...userAreaRows.map(a => a.areaId), ...repAreaRows.map(a => a.areaId)])];
      if (repAreaIds.length > 0) {
        areaFilter = { areaId: { in: repAreaIds } };
      }
    }

    const doctors = await prisma.doctor.findMany({
      where: {
        userId:   plan.userId,
        isActive: true,
        ...(q ? { name: { contains: String(q) } } : {}),
        id: { notIn: usedIds },
        // When searching by name (q provided): skip area filter so all 4167 doctors
        // under this account are searchable. Area filter only applies when browsing.
        ...(q ? {} : areaFilter),
      },
      select: {
        id: true, name: true, specialty: true, pharmacyName: true,
        areaId: true,
        area: { select: { name: true } },
      },
      take: q ? 20 : 50,
      orderBy: { name: 'asc' },
    });

    // Sort: startsWith the query first, then contains
    if (q?.trim()) {
      const qNorm = String(q).trim().toLowerCase()
        .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
      doctors.sort((a, b) => {
        const aN = a.name.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
        const bN = b.name.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
        const aS = aN.startsWith(qNorm) ? 0 : 1;
        const bS = bN.startsWith(qNorm) ? 0 : 1;
        if (aS !== bS) return aS - bS;
        return aN.localeCompare(bN, 'ar');
      });
    }

    res.json(doctors.slice(0, 10));
  } catch (e) { next(e); }
}

// ── Update plan areas (add/remove) ───────────────────────────
export async function updatePlanAreas(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const { areaIds } = req.body; // new full list of area IDs
    if (!Array.isArray(areaIds)) return res.status(400).json({ error: 'areaIds must be an array' });

    const plan = await findAccessiblePlan(planId, req.user.id, req.user.role);
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود' });

    // Delete all existing plan areas and recreate
    await prisma.planArea.deleteMany({ where: { planId } });
    if (areaIds.length > 0) {
      await prisma.planArea.createMany({
        data: areaIds.map(id => ({ planId, areaId: parseInt(id) })),
        skipDuplicates: true,
      });
    }

    const updated = await prisma.planArea.findMany({
      where: { planId },
      include: { area: { select: { id: true, name: true } } },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

export async function transferPlan(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId مطلوب.' });
    }

    // Only admin / manager / manager-like roles can transfer
    const role = req.user.role;
    const managerRoles = ['admin','manager','company_manager','supervisor','product_manager','team_leader','office_manager','commercial_supervisor','commercial_team_leader'];
    if (!managerRoles.includes(role)) {
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
    // Allow reps (scientific_rep, team_leader, supervisor, etc.) in addition to classic 'user' role
    const repRoles = ['user','scientific_rep','team_leader','supervisor','commercial_rep'];
    if (!repRoles.includes(targetUser.role)) {
      return res.status(400).json({ error: 'يمكن تحويل البلان إلى المندوبين فقط.' });
    }
    // Check link: either classic linkedRepId match OR the user is the userId of the ScientificRepresentative
    // Skip check if plan has no rep assigned yet (unassigned plan)
    if (plan.scientificRepId) {
      const scientificRep = await prisma.scientificRepresentative.findUnique({
        where: { id: plan.scientificRepId },
        select: { userId: true },
      });
      const linkedByRepId  = targetUser.linkedRepId === plan.scientificRepId;
      const linkedByUserId = scientificRep?.userId === targetUser.id;
      if (!linkedByRepId && !linkedByUserId) {
        return res.status(400).json({ error: 'حساب المستخدم المحدد غير مرتبط بنفس المندوب العلمي الخاص بهذا البلان.' });
      }
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
    const managerRoles = ['admin','manager','company_manager','supervisor','product_manager','team_leader','office_manager','commercial_supervisor','commercial_team_leader'];
    if (!managerRoles.includes(role)) {
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

// ── Get pharmacy visits for a plan's rep/month ────────────────
// GET /api/monthly-plans/:id/pharmacy-visits
export async function getPharmacyVisits(req, res, next) {
  try {
    const planId = parseInt(req.params.id);
    const uid    = req.user.id;
    const role   = req.user.role;

    const REP_ROLES = new Set(['user','scientific_rep','team_leader','supervisor','commercial_rep']);
    const accessWhere = REP_ROLES.has(role)
      ? { id: planId, OR: [{ assignedUserId: uid }, { userId: uid }] }
      : { id: planId, userId: uid };

    const plan = await prisma.monthlyPlan.findFirst({ where: accessWhere, select: { scientificRepId: true, month: true, year: true } });
    if (!plan) return res.status(404).json({ error: 'البلان غير موجود.' });

    const monthStart = new Date(plan.year, plan.month - 1, 1);
    const monthEnd   = new Date(plan.year, plan.month, 1);

    const visits = await prisma.pharmacyVisit.findMany({
      where: {
        scientificRepId: plan.scientificRepId,
        visitDate: { gte: monthStart, lt: monthEnd },
      },
      include: {
        area:  { select: { id: true, name: true } },
        items: { include: { item: { select: { id: true, name: true } } } },
        likes: { select: { id: true, userId: true, user: { select: { id: true, username: true } } } },
      },
      orderBy: { visitDate: 'asc' },
    });

    res.json(visits);
  } catch (e) { next(e); }
}
