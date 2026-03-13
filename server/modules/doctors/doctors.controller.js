import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';
import fs from 'fs';

export async function visitsByArea(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;

    // Optional month/year filter
    const filterMonth = req.query.month ? parseInt(req.query.month) : null;
    const filterYear  = req.query.year  ? parseInt(req.query.year)  : null;
    const dateFilter  = (filterMonth && filterYear) ? {
      gte: new Date(filterYear, filterMonth - 1, 1),
      lt:  new Date(filterYear, filterMonth, 1),
    } : undefined;

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    const isFieldRep  = FIELD_ROLES.includes(role);

    let doctors;

    if (isFieldRep) {
      const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      const linkedRepId = userRow?.linkedRepId;
      console.log('[visitsByArea] fieldRep userId:', userId, 'linkedRepId:', linkedRepId);

      // جلب كل الزيارات بدون فلتر شهر — لتحديد قائمة الأطباء الكاملة
      const allVisitsEver = await prisma.doctorVisit.findMany({
        where: { scientificRepId: linkedRepId ?? -1 },
        select: { doctorId: true },
      });
      const everVisitedIds = new Set(allVisitsEver.map(v => v.doctorId));

      // جلب الزيارات المفلترة بالشهر (للإحصاءات فقط)
      const allVisits = await prisma.doctorVisit.findMany({
        where: {
          scientificRepId: linkedRepId ?? -1,
          ...(dateFilter ? { visitDate: dateFilter } : {}),
        },
        select: {
          id: true, visitDate: true, feedback: true, notes: true,
          doctorId: true,
          item: { select: { id: true, name: true } },
        },
        orderBy: { visitDate: 'desc' },
      });

      // تجميع الزيارات المفلترة حسب doctorId
      const visitsByDoc = new Map();
      for (const v of allVisits) {
        if (!visitsByDoc.has(v.doctorId)) visitsByDoc.set(v.doctorId, []);
        visitsByDoc.get(v.doctorId).push(v);
      }

      // جلب كل أطباء المندوب (مسجّلون بحسابه) + كل من زاره في أي وقت
      const extraIds = [...everVisitedIds];
      const allDoctors = await prisma.doctor.findMany({
        where: {
          OR: [
            { userId },
            ...(extraIds.length > 0 ? [{ id: { in: extraIds } }] : []),
          ],
        },
        include: {
          area:       { select: { id: true, name: true } },
          targetItem: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
      });

      // دمج: الزيارات المفلترة للشهر المحدد فقط
      doctors = allDoctors.map(d => ({ ...d, visits: visitsByDoc.get(d.id) ?? [] }));
      console.log('[visitsByArea] total doctors:', allDoctors.length);

    } else {
      // للمدير: جلب أطباءه جميعاً دائماً، وفلتر الزيارات فقط حسب الشهر
      doctors = await prisma.doctor.findMany({
        where: { userId },
        include: {
          area:       { select: { id: true, name: true } },
          targetItem: { select: { id: true, name: true } },
          visits: {
            where: dateFilter ? { visitDate: dateFilter } : undefined,
            orderBy: { visitDate: 'desc' },
            select: {
              id: true, visitDate: true, feedback: true, notes: true,
              item: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { name: 'asc' },
      });
    }

    const areaMap = new Map();
    const noAreaDocs = [];

    for (const d of doctors) {
      const visited   = d.visits.length > 0;
      const isWriting = d.visits.some(v => v.feedback === 'writing');
      const doc = {
        id: d.id, name: d.name, specialty: d.specialty,
        pharmacyName: d.pharmacyName ?? null,
        area: d.area ?? null,
        targetItem: d.targetItem, isActive: d.isActive,
        visited, isWriting, visits: d.visits,
      };
      if (d.area) {
        if (!areaMap.has(d.area.id))
          areaMap.set(d.area.id, { id: d.area.id, name: d.area.name, doctors: [] });
        areaMap.get(d.area.id).doctors.push(doc);
      } else {
        noAreaDocs.push(doc);
      }
    }

    const toStats = g => ({
      ...g,
      totalDoctors: g.doctors.length,
      visitedCount: g.doctors.filter(d => d.visited).length,
      writingCount: g.doctors.filter(d => d.isWriting).length,
    });

    const areas = [...areaMap.values()].map(toStats)
      .sort((a, b) => b.visitedCount - a.visitedCount);

    if (noAreaDocs.length > 0)
      areas.push(toStats({ id: null, name: 'بدون منطقة', doctors: noAreaDocs }));

    res.json({ areas });
  } catch (e) { next(e); }
}

export async function list(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const { areaId, isActive } = req.query;

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    const isFieldRep  = FIELD_ROLES.includes(role);

    let doctorIds = null; // null = no extra filter needed

    if (isFieldRep) {
      // جلب linkedRepId
      const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      const linkedRepId = userRow?.linkedRepId;

      if (linkedRepId) {
        // أطباء تمت زيارتهم من قِبل هذا المندوب
        const visits = await prisma.doctorVisit.findMany({
          where: { scientificRepId: linkedRepId },
          select: { doctorId: true },
          distinct: ['doctorId'],
        });
        const visitedIds = visits.map(v => v.doctorId);
        // دمج مع أطباء مسجّلين بحسابه مباشرة
        const ownDocs = await prisma.doctor.findMany({ where: { userId }, select: { id: true } });
        const ownIds  = ownDocs.map(d => d.id);
        doctorIds = [...new Set([...ownIds, ...visitedIds])];
      }
    }

    const where = doctorIds !== null
      ? { id: { in: doctorIds } }
      : { userId };

    if (areaId)    where.areaId   = parseInt(areaId);
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const doctors = await prisma.doctor.findMany({
      where,
      include: {
        area:       { select: { id: true, name: true } },
        targetItem: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json(doctors);
  } catch (e) { next(e); }
}

export async function getOne(req, res, next) {
  try {
    const doctor = await prisma.doctor.findFirst({
      where: { id: parseInt(req.params.id), userId: req.user.id },
      include: {
        area:       { select: { id: true, name: true } },
        targetItem: { select: { id: true, name: true } },
        visits: {
          orderBy: { visitDate: 'desc' },
          take: 10,
        },
      },
    });
    if (!doctor) return res.status(404).json({ error: 'Not found' });
    res.json(doctor);
  } catch (e) { next(e); }
}

export async function create(req, res, next) {
  try {
    const userId = req.user.id;
    const { name, specialty, areaId, pharmacyName, targetItemId, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const doctor = await prisma.doctor.create({
      data: {
        name, specialty, pharmacyName, notes,
        areaId:       areaId       ? parseInt(areaId)       : null,
        targetItemId: targetItemId ? parseInt(targetItemId) : null,
        userId,
      },
      include: {
        area:       { select: { id: true, name: true } },
        targetItem: { select: { id: true, name: true } },
      },
    });
    res.status(201).json(doctor);
  } catch (e) { next(e); }
}

export async function update(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const id = parseInt(req.params.id);
    const { name, specialty, areaId, pharmacyName, targetItemId, notes, isActive } = req.body;

    // التحقق من وجود الطبيب أولاً (يمكن أن يكون مسجّلاً بحساب آخر لكن زاره المندوب)
    const existing = await prisma.doctor.findUnique({ where: { id }, select: { id: true, userId: true } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    const isFieldRep  = FIELD_ROLES.includes(role);

    // المندوب يمكنه تعديل أي طبيب زاره؛ المدير يعدّل أطباءه فقط
    if (!isFieldRep && existing.userId !== userId) {
      return res.status(403).json({ error: 'غير مصرح' });
    }

    await prisma.doctor.update({
      where: { id },
      data: {
        ...(name         !== undefined && { name }),
        ...(specialty    !== undefined && { specialty }),
        ...(pharmacyName !== undefined && { pharmacyName }),
        ...(notes        !== undefined && { notes }),
        ...(isActive     !== undefined && { isActive }),
        ...(areaId       !== undefined && { areaId:       areaId       ? parseInt(areaId)       : null }),
        ...(targetItemId !== undefined && { targetItemId: targetItemId ? parseInt(targetItemId) : null }),
      },
    });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function remove(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const id = parseInt(req.params.id);

    const existing = await prisma.doctor.findUnique({ where: { id }, select: { id: true, userId: true } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    // المندوب يحذف فقط أطباءه المسجّلين بحسابه؛ الأطباء من حسابات أخرى لا يحذفها
    if (!['admin', 'manager', 'company_manager'].includes(role) && existing.userId !== userId) {
      return res.status(403).json({ error: 'لا يمكنك حذف هذا الطبيب' });
    }

    await prisma.doctor.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function deleteAll(req, res, next) {
  try {
    const userId = req.user.id;
    const result = await prisma.doctor.deleteMany({ where: { userId } });
    res.json({ deleted: result.count });
  } catch (e) { next(e); }
}

// ── Import doctors from Excel ────────────────────────────────
// Auto-detects column names by fuzzy matching Arabic/English keywords.
// Returns detected columns so frontend can show them.
export async function importExcel(req, res, next) {
  try {
    const userId = req.user.id;
    if (!req.file) return res.status(400).json({ error: 'لم يتم إرسال ملف' });

    const workbook = XLSX.readFile(req.file.path);
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    fs.unlink(req.file.path, () => {});

    if (rows.length === 0) return res.status(400).json({ error: 'الملف فارغ' });

    // ── Auto-detect column mapping ───────────────────────────
    const allCols = Object.keys(rows[0]);
    const detectedCols = allCols; // return to frontend for debugging

    // keywords per field — order matters (more specific first)
    const COL_KEYWORDS = {
      name:     ['doctor name','اسم الطبيب','اسم الدكتور','اسم د','الاسم','name','doctor'],
      specialty:['speciality','specialty','التخصص','تخصص','spec','speciali'],
      area:     ['area (zone)','area zone','المنطقة','منطقه','منطقة','area','region','zone'],
      pharmacy: ['الصيدلية','صيدليه','صيدلية','pharmacy','clinic','عياده','عيادة'],
      item:     ['target drug','target item','الايتم المستهدف','الدواء المستهدف','الايتم','الايتيم',
                 'الدواء','medicine','drug','item','product','المنتج','brand','الحبه','الكبسوله'],
      notes:    ['ملاحظات','ملاحظة','notes','note','تعليق','comment'],
    };

    const findCol = (keywords) => {
      for (const kw of keywords) {
        const col = allCols.find(c =>
          c.trim().toLowerCase() === kw.toLowerCase() ||
          c.trim().toLowerCase().includes(kw.toLowerCase()) ||
          kw.toLowerCase().includes(c.trim().toLowerCase())
        );
        if (col) return col;
      }
      return null;
    };

    const colMap = {
      name:     findCol(COL_KEYWORDS.name),
      specialty:findCol(COL_KEYWORDS.specialty),
      area:     findCol(COL_KEYWORDS.area),
      pharmacy: findCol(COL_KEYWORDS.pharmacy),
      item:     findCol(COL_KEYWORDS.item),
      notes:    findCol(COL_KEYWORDS.notes),
    };

    // Fallback: assign any undetected column that hasn't been claimed to item or notes
    const usedCols = new Set(Object.values(colMap).filter(Boolean));
    const unusedCols = allCols.filter(c => !usedCols.has(c));
    if (!colMap.item && unusedCols.length > 0) {
      // pick the last unused column (most likely to be item/drug in typical survey files)
      colMap.item = unusedCols[unusedCols.length - 1];
    }
    if (!colMap.notes && unusedCols.length > 1) {
      colMap.notes = unusedCols.find(c => c !== colMap.item) ?? null;
    }

    // If name column not found, return error with detected columns for user
    if (!colMap.name) {
      return res.status(422).json({
        error: 'تعذّر إيجاد عمود اسم الطبيب في الملف',
        detectedCols,
        colMap,
        hint: 'يرجى التأكد أن الملف يحتوي على عمود باسم "اسم الطبيب" أو "الاسم"',
      });
    }

    // Pre-load areas and items for matching
    const [allAreas, allItems] = await Promise.all([
      prisma.area.findMany({ where: { userId }, select: { id: true, name: true } }),
      prisma.item.findMany({ where: { userId }, select: { id: true, name: true } }),
    ]);

    const findId = (list, val) => {
      if (!val || !String(val).trim()) return null;
      const v = String(val).trim().toLowerCase();
      // exact match first
      let found = list.find(x => x.name.toLowerCase() === v);
      if (!found) found = list.find(x => x.name.toLowerCase().includes(v) || v.includes(x.name.toLowerCase()));
      return found?.id ?? null;
    };

    const getVal = (row, col) => col ? String(row[col] ?? '').trim() : '';

    let imported = 0;
    let skipped  = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i];
      const name = getVal(row, colMap.name);
      if (!name) { skipped++; continue; }

      const specialty    = getVal(row, colMap.specialty)    || null;
      const pharmacyName = getVal(row, colMap.pharmacy)     || null;
      const notes        = getVal(row, colMap.notes)        || null;
      const areaVal      = getVal(row, colMap.area);
      const itemVal      = getVal(row, colMap.item);

      const areaId = findId(allAreas, areaVal);

      // Find item by fuzzy match; if not found but value exists → create it
      let targetItemId = findId(allItems, itemVal);
      if (!targetItemId && itemVal) {
        try {
          const newItem = await prisma.item.upsert({
            where: { name_userId: { name: itemVal, userId } },
            update: {},
            create: { name: itemVal, userId },
            select: { id: true },
          });
          targetItemId = newItem.id;
          // Add to local cache so later rows reuse the same item
          allItems.push({ id: newItem.id, name: itemVal });
        } catch (_) { /* leave null if upsert fails */ }
      }

      try {
        const existing = await prisma.doctor.findFirst({ where: { name, userId } });
        if (existing) {
          await prisma.doctor.update({
            where: { id: existing.id },
            data: { specialty, pharmacyName, notes, areaId, targetItemId },
          });
        } else {
          await prisma.doctor.create({
            data: { name, specialty, pharmacyName, notes, areaId, targetItemId, userId },
          });
        }
        imported++;
      } catch (e) {
        errors.push({ row: i + 2, name, error: e.message });
      }
    }

    res.json({ imported, skipped, errors, total: rows.length, colMap, detectedCols });
  } catch (e) { next(e); }
}
