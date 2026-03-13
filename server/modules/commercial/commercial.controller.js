import prisma from '../../lib/prisma.js';
import XLSX   from 'xlsx';
import fs     from 'fs';
import crypto from 'crypto';

// ── Role helpers ─────────────────────────────────────────────
const COMM_REP_ROLES  = new Set(['commercial_rep']);
const COMM_LEAD_ROLES = new Set(['commercial_team_leader', 'commercial_supervisor']);
const MGR_ROLES       = new Set(['admin', 'manager', 'office_manager', 'company_manager']);
const ALL_COMM_ROLES  = new Set([...COMM_REP_ROLES, ...COMM_LEAD_ROLES, ...MGR_ROLES]);

const isRep      = role => COMM_REP_ROLES.has(role);
const isLead     = role => COMM_LEAD_ROLES.has(role);
const isMgr      = role => MGR_ROLES.has(role);
const isRepOrLead = role => isRep(role) || isLead(role);

// Normalize header for Excel import
const normHeader = s => String(s ?? '')
  .toLowerCase()
  .replace(/[\u064B-\u065F]/g, '')
  .replace(/[\s_\-\.]+/g, '')
  .trim();

// Build date from various formats
const parseDate = raw => {
  if (!raw) return new Date();
  if (typeof raw === 'number') {
    const d = new Date((raw - 25569) * 86400 * 1000);
    if (!isNaN(d.getTime())) return d;
  }
  const s = String(raw).trim();
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  // dd/mm/yyyy
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) return new Date(`${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
  return new Date();
};

// ─── STATS ────────────────────────────────────────────────────
export async function getStats(req, res, next) {
  try {
    const { id: userId, role } = req.user;

    // Build where clause based on role
    const invoiceWhere = isMgr(role)
      ? { userId }
      : isLead(role)
        ? { createdByUserId: userId }
        : { assignedRepId: userId };

    // DEBUG
    console.log('[getStats]', { role, userId, invoiceWhere: JSON.stringify(invoiceWhere) });

    const [total, pending, partial, collected, overdue] = await Promise.all([
      prisma.commercialInvoice.count({ where: invoiceWhere }),
      prisma.commercialInvoice.count({ where: { ...invoiceWhere, status: 'pending' } }),
      prisma.commercialInvoice.count({ where: { ...invoiceWhere, status: 'partial' } }),
      prisma.commercialInvoice.count({ where: { ...invoiceWhere, status: 'collected' } }),
      prisma.commercialInvoice.count({
        where: {
          ...invoiceWhere,
          status: { not: 'collected' },
          maxCollectionDate: { lt: new Date() },
        },
      }),
    ]);

    // Total amounts
    const amtAgg = await prisma.commercialInvoice.aggregate({
      where: invoiceWhere,
      _sum: { totalAmount: true, collectedAmount: true },
    });

    // Recent collections (last 7d)
    const collWhere = isMgr(role)
      ? {}
      : isLead(role)
        ? {}
        : { collectedById: userId };
    const recentCollections = await prisma.collectionRecord.findMany({
      where: {
        ...collWhere,
        collectedAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
      },
      include: {
        invoice: { select: { pharmacyName: true, invoiceNumber: true } },
        collectedBy: { select: { username: true, displayName: true } },
      },
      orderBy: { collectedAt: 'desc' },
      take: 10,
    });

    // Reps summary (for manager/lead)
    let repsSummary = [];
    if (isMgr(role) || isLead(role)) {
      const reps = await prisma.user.findMany({
        where: { role: 'commercial_rep', ...(isMgr(role) ? {} : {}) },
        select: {
          id: true, username: true, displayName: true,
          assignedInvoices: {
            where: isMgr(role) ? { userId } : {},
            select: { status: true, totalAmount: true, collectedAmount: true },
          },
        },
      });
      repsSummary = reps.map(r => ({
        id: r.id,
        name: r.displayName ?? r.username,
        total: r.assignedInvoices.length,
        pending: r.assignedInvoices.filter(i => i.status === 'pending').length,
        partial: r.assignedInvoices.filter(i => i.status === 'partial').length,
        collected: r.assignedInvoices.filter(i => i.status === 'collected').length,
        totalAmount: r.assignedInvoices.reduce((s, i) => s + i.totalAmount, 0),
        collectedAmount: r.assignedInvoices.reduce((s, i) => s + i.collectedAmount, 0),
      }));
    }

    res.json({
      counts: { total, pending, partial, collected, overdue },
      amounts: {
        total: amtAgg._sum.totalAmount ?? 0,
        collected: amtAgg._sum.collectedAmount ?? 0,
        remaining: (amtAgg._sum.totalAmount ?? 0) - (amtAgg._sum.collectedAmount ?? 0),
      },
      recentCollections,
      repsSummary,
    });
  } catch (e) { next(e); }
}

// ─── LIST INVOICES ────────────────────────────────────────────
export async function listInvoices(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    const { status, repId, pharmacyName, dateFrom, dateTo, take = '50', skip = '0' } = req.query;

    let where = {};
    if (isMgr(role))       where = { userId };
    else if (isLead(role)) where = { createdByUserId: userId };
    else                   where = { assignedRepId: userId };

    // status can be a single value or an array (e.g., status=pending&status=partial)
    const statusFilter = Array.isArray(status)
      ? status
      : status === 'open' ? ['pending', 'partial'] : status ? [status] : null;
    if (statusFilter) where.status = statusFilter.length === 1 ? statusFilter[0] : { in: statusFilter };
    if (repId)        where.assignedRepId = parseInt(repId);
    if (pharmacyName) where.pharmacyName = { contains: pharmacyName };
    if (dateFrom || dateTo) {
      where.invoiceDate = {};
      if (dateFrom) where.invoiceDate.gte = new Date(dateFrom);
      if (dateTo)   where.invoiceDate.lte = new Date(dateTo);
    }

    // DEBUG
    console.log('[listInvoices]', { role, userId, where: JSON.stringify(where), take, skip });

    const [invoices, total] = await Promise.all([
      prisma.commercialInvoice.findMany({
        where,
        include: {
          items: true,
          collections: { orderBy: { collectedAt: 'desc' }, take: 1 },
          assignedRep: { select: { id: true, username: true, displayName: true } },
        },
        orderBy: [{ status: 'asc' }, { invoiceDate: 'asc' }],
        take: parseInt(take),
        skip: parseInt(skip),
      }),
      prisma.commercialInvoice.count({ where }),
    ]);

    res.json({ data: invoices, total });
  } catch (e) { next(e); }
}

// ─── GET SINGLE INVOICE ───────────────────────────────────────
export async function getInvoice(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    const id = parseInt(req.params.id);

    const inv = await prisma.commercialInvoice.findFirst({
      where: {
        id,
        ...(isMgr(role) ? { userId } : isLead(role) ? { createdByUserId: userId } : { assignedRepId: userId }),
      },
      include: {
        items: { include: { item: { select: { id: true, name: true } } } },
        collections: {
          include: { collectedBy: { select: { id: true, username: true, displayName: true } } },
          orderBy: { collectedAt: 'desc' },
        },
        assignedRep: { select: { id: true, username: true, displayName: true } },
        pharmacy: true,
      },
    });

    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    res.json(inv);
  } catch (e) { next(e); }
}

// ─── CREATE INVOICE (manual) ─────────────────────────────────
export async function createInvoice(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    if (!isMgr(role)) return res.status(403).json({ error: 'Managers only' });

    const {
      invoiceNumber, invoiceDate, dueDate, maxCollectionDate, deferredDays,
      paymentType, pharmacyId, pharmacyName, areaName,
      assignedRepId, totalAmount, notes, items = [],
    } = req.body;

    const inv = await prisma.commercialInvoice.create({
      data: {
        invoiceNumber: String(invoiceNumber),
        invoiceDate:   invoiceDate ? new Date(invoiceDate) : new Date(),
        dueDate:       dueDate ? new Date(dueDate) : null,
        maxCollectionDate: maxCollectionDate ? new Date(maxCollectionDate) : null,
        deferredDays:  deferredDays ? parseInt(deferredDays) : null,
        paymentType:   paymentType ?? 'cash',
        pharmacyId:    pharmacyId ? parseInt(pharmacyId) : null,
        pharmacyName:  String(pharmacyName ?? ''),
        areaName:      areaName ?? null,
        assignedRepId: parseInt(assignedRepId),
        createdByUserId: userId,
        userId,
        totalAmount:   parseFloat(totalAmount) || 0,
        notes:         notes ?? null,
        items: items.length ? {
          create: items.map(it => ({
            brandName:     String(it.brandName ?? ''),
            scientificName: it.scientificName ?? null,
            dosage:        it.dosage ?? null,
            form:          it.form ?? null,
            unitPrice:     parseFloat(it.unitPrice) || 0,
            quantity:      parseInt(it.quantity) || 1,
            bonusQty:      parseInt(it.bonusQty) || 0,
            totalPrice:    (parseFloat(it.unitPrice) || 0) * (parseInt(it.quantity) || 1),
            itemId:        it.itemId ? parseInt(it.itemId) : null,
          })),
        } : undefined,
      },
      include: { items: true },
    });

    res.status(201).json(inv);
  } catch (e) { next(e); }
}

// ─── UPDATE INVOICE ───────────────────────────────────────────
export async function updateInvoice(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    if (!isMgr(role)) return res.status(403).json({ error: 'Managers only' });
    const id = parseInt(req.params.id);
    const { invoiceDate, dueDate, maxCollectionDate, deferredDays, paymentType,
            pharmacyName, areaName, assignedRepId, totalAmount, notes, status } = req.body;

    const inv = await prisma.commercialInvoice.findFirst({ where: { id, userId } });
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const updated = await prisma.commercialInvoice.update({
      where: { id },
      data: {
        ...(invoiceDate && { invoiceDate: new Date(invoiceDate) }),
        ...(dueDate && { dueDate: new Date(dueDate) }),
        ...(maxCollectionDate && { maxCollectionDate: new Date(maxCollectionDate) }),
        ...(deferredDays != null && { deferredDays: parseInt(deferredDays) }),
        ...(paymentType && { paymentType }),
        ...(pharmacyName && { pharmacyName }),
        ...(areaName != null && { areaName }),
        ...(assignedRepId && { assignedRepId: parseInt(assignedRepId) }),
        ...(totalAmount != null && { totalAmount: parseFloat(totalAmount) }),
        ...(notes != null && { notes }),
        ...(status && { status }),
      },
      include: { items: true, collections: true },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

// ─── DELETE INVOICE ───────────────────────────────────────────
export async function deleteInvoice(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    if (!isMgr(role)) return res.status(403).json({ error: 'Managers only' });
    const id = parseInt(req.params.id);
    const inv = await prisma.commercialInvoice.findFirst({ where: { id, userId } });
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    await prisma.commercialInvoice.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ─── IMPORT INVOICES FROM EXCEL ───────────────────────────────
export async function importInvoices(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    // Managers can import for any rep; reps can import only for themselves
    if (!isMgr(role) && !isRep(role)) return res.status(403).json({ error: 'Forbidden' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.unlink(req.file.path, () => {});

    if (!rows.length) return res.json({ imported: 0, total: 0, errors: [], unmatched: [] });

    const headers = Object.keys(rows[0]);
    const ALIASES = {
      invoiceNumber:  ['رقمالفاتوره','رقمالفاتورة','invoice','invoicenumber','رقم'],
      invoiceDate:    ['تاريخالفاتوره','تاريخالفاتورة','invoicedate','تاريخ'],
      dueDate:        ['تاريخالاستحقاق','استحقاق','duedate','due'],
      maxDate:        ['اقصىموعد','موعداقصى','maxdate','maxcollection'],
      deferredDays:   ['ايامتاجيل','اياموتاجيل','deferreddays','days'],
      paymentType:    ['نوعالدفع','cash','deferred','نوع'],
      pharmacyName:   ['اسمالصيدليه','اسمالصيدلية','pharmacyname','pharmacy','صيدلية','صيدليه'],
      areaName:       ['المنطقه','المنطقة','area','منطقة','منطقه'],
      repName:        ['اسمالمندوب','المندوب','rep','repname','مندوب'],
      brandName:      ['الاسمالتجاري','تجاري','brand','brandname','اسمتجاري'],
      scientificName: ['الاسمالعلمي','علمي','scientific','scientificname'],
      dosage:         ['الجرعه','الجرعة','جرعه','جرعة','dosage'],
      form:           ['الشكل','form','شكلدوائي'],
      unitPrice:      ['السعر','سعر','price','unitprice'],
      quantity:       ['الكميه','الكمية','كميه','كمية','qty','quantity'],
      bonusQty:       ['بونص','مجاني','bonus','bonusqty','كميهمجانيه'],
      totalPrice:     ['المجموع','اجمالي','total','totalprice'],
    };
    const colMap = {};
    for (const h of headers) {
      const n = normHeader(h);
      for (const [field, aliases] of Object.entries(ALIASES)) {
        if (!colMap[field] && aliases.some(a => a === n || n.includes(a) || a.includes(n))) {
          colMap[field] = h; break;
        }
      }
    }
    const g = (row, f) => colMap[f] != null ? row[colMap[f]] : '';

    // Load reps for matching
    const reps = await prisma.user.findMany({
      where: { role: 'commercial_rep' },
      select: { id: true, username: true, displayName: true },
    });
    const normName = s => String(s ?? '').toLowerCase().replace(/\s+/g,'').trim();
    const findRep = name => {
      const n = normName(name);
      return reps.find(r => normName(r.displayName ?? r.username) === n) ??
             reps.find(r => normName(r.displayName ?? r.username).includes(n) || n.includes(normName(r.displayName ?? r.username)));
    };

    // Group rows by invoice number
    const invoiceMap = new Map();
    for (const row of rows) {
      const num = String(g(row, 'invoiceNumber') || '').trim();
      if (!num) continue;
      const key = `${num}__${normName(g(row,'pharmacyName'))}`;
      if (!invoiceMap.has(key)) {
        invoiceMap.set(key, { invoiceNumber: num, rows: [] });
      }
      invoiceMap.get(key).rows.push(row);
    }

    const errors = [];
    const unmatched = [];
    let imported = 0;

    for (const [, inv] of invoiceMap) {
      const firstRow = inv.rows[0];
      let rep;
      if (isRep(role)) {
        // Rep uploads for themselves — ignore repName column
        rep = reps.find(r => r.id === userId) ?? { id: userId };
      } else {
        const repName = String(g(firstRow, 'repName') || '').trim();
        rep = findRep(repName);
        if (!rep) { unmatched.push(repName || '(فارغ)'); continue; }
      }

      const pharmacyName = String(g(firstRow, 'pharmacyName') || '').trim();
      const payType      = normName(g(firstRow, 'paymentType')).includes('deferred') || normName(g(firstRow, 'paymentType')).includes('آجل') ? 'deferred' : 'cash';
      const deferredDays = parseInt(g(firstRow, 'deferredDays')) || null;
      const invDate      = parseDate(g(firstRow, 'invoiceDate'));
      const dueDate      = g(firstRow, 'dueDate') ? parseDate(g(firstRow, 'dueDate')) : null;
      const maxDate      = g(firstRow, 'maxDate') ? parseDate(g(firstRow, 'maxDate'))
        : (dueDate ? new Date(dueDate.getTime() + 7*24*3600*1000) : null);

      const items = inv.rows.map(row => {
        const up = parseFloat(g(row,'unitPrice')) || 0;
        const qty = parseInt(g(row,'quantity')) || 1;
        return {
          brandName:     String(g(row,'brandName') || '').trim() || '(غير محدد)',
          scientificName: String(g(row,'scientificName') || '').trim() || null,
          dosage:        String(g(row,'dosage') || '').trim() || null,
          form:          String(g(row,'form') || '').trim() || null,
          unitPrice: up, quantity: qty, bonusQty: parseInt(g(row,'bonusQty')) || 0,
          totalPrice: up * qty,
        };
      });
      const totalAmount = items.reduce((s, it) => s + it.totalPrice, 0);

      try {
        // Skip if already imported (same invoiceNumber + same userId)
        const exists = await prisma.commercialInvoice.findFirst({
          where: { invoiceNumber: inv.invoiceNumber, userId, pharmacyName },
        });
        if (exists) { errors.push({ invoiceNumber: inv.invoiceNumber, error: 'موجود مسبقاً' }); continue; }

        await prisma.commercialInvoice.create({
          data: {
            invoiceNumber: inv.invoiceNumber,
            invoiceDate: invDate,
            dueDate, maxCollectionDate: maxDate,
            deferredDays, paymentType: payType,
            pharmacyName,
            areaName: String(g(firstRow,'areaName') || '').trim() || null,
            assignedRepId: rep.id,
            createdByUserId: userId, userId,
            totalAmount,
            items: { create: items },
          },
        });

        // Notify assigned rep
        await prisma.appNotification.create({
          data: {
            userId: rep.id, fromUserId: userId,
            type: 'invoice_added',
            title: `📄 فاتورة جديدة: ${pharmacyName}`,
            body: `تم إضافة فاتورة رقم ${inv.invoiceNumber} — ${totalAmount.toLocaleString()} د.ع`,
            data: JSON.stringify({ invoiceNumber: inv.invoiceNumber, totalAmount }),
          },
        });

        imported++;
      } catch (err) {
        errors.push({ invoiceNumber: inv.invoiceNumber, error: err.message });
      }
    }

    res.json({ imported, total: invoiceMap.size, errors, unmatched });
  } catch (e) { next(e); }
}

// ─── COLLECT ─────────────────────────────────────────────────
export async function collect(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    const invoiceId = parseInt(req.params.id);
    const {
      amount, discount = 0, isFullCollection = false,
      notes, latitude, longitude,
      returnedItems = [],   // [{itemId, returnQty}]
    } = req.body;

    // Access check
    const where = { id: invoiceId };
    if (!isMgr(role)) where.assignedRepId = userId;

    const inv = await prisma.commercialInvoice.findFirst({ where, include: { items: true } });
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status === 'collected') return res.status(400).json({ error: 'تم الاستحصال بالكامل مسبقاً' });

    // ── Calculate returned goods value ─────────────────────────
    let returnedAmount = 0;
    const returnDetails = [];
    if (Array.isArray(returnedItems) && returnedItems.length > 0) {
      for (const ret of returnedItems) {
        if (!ret.returnQty || ret.returnQty <= 0) continue;
        const item = inv.items.find(it => it.id === ret.itemId);
        if (!item) continue;
        const retQty  = Math.min(parseInt(ret.returnQty), item.quantity);
        const retValue = retQty * item.unitPrice;
        returnedAmount += retValue;
        returnDetails.push({ itemId: item.id, name: item.brandName, returnQty: retQty, unitPrice: item.unitPrice, returnValue: retValue });
      }
    }

    // ── Calculate amounts ──────────────────────────────────────
    const amt        = parseFloat(amount);
    const disc       = parseFloat(discount) || 0;
    const finalAmt   = amt - disc;

    // Effective total = original - all previous returns - this return
    const totalReturned = (inv.returnedAmount ?? 0) + returnedAmount;
    const effectiveTotal = Math.max(0, inv.totalAmount - totalReturned);
    const newCollected   = inv.collectedAmount + finalAmt;
    const remaining      = effectiveTotal - newCollected;

    // Generate receipt number: RC-YYYYMMDD-xxxx
    const now     = new Date();
    const dateStr = now.toISOString().slice(0,10).replace(/-/g,'');
    const count   = await prisma.collectionRecord.count();
    const receiptNumber = `RC-${dateStr}-${String(count + 1).padStart(4,'0')}`;

    const newStatus = (remaining <= 0 || isFullCollection)
      ? 'collected'
      : 'partial';

    // Transaction: create record + update invoice
    const [record] = await prisma.$transaction([
      prisma.collectionRecord.create({
        data: {
          invoiceId, collectedById: userId,
          amount: amt, discount: disc, finalAmount: finalAmt,
          returnedAmount,
          returnedItemsJson: returnDetails.length > 0 ? JSON.stringify(returnDetails) : null,
          isFullCollection: newStatus === 'collected',
          notes: notes ?? null,
          latitude:  latitude  ? parseFloat(latitude)  : null,
          longitude: longitude ? parseFloat(longitude) : null,
          receiptNumber,
          collectedAt: now,
        },
      }),
      prisma.commercialInvoice.update({
        where: { id: invoiceId },
        data: {
          collectedAmount: newCollected,
          returnedAmount:  totalReturned,
          status: newStatus,
        },
      }),
    ]);

    // Notify managers
    const managers = await prisma.user.findMany({
      where: { role: { in: ['admin','manager','office_manager'] } },
      select: { id: true },
    });
    if (managers.length) {
      const repUser = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, displayName: true } });
      const repName = repUser?.displayName ?? repUser?.username ?? 'المندوب';
      const notifType = newStatus === 'collected' ? 'collection_done' : 'collection_partial';
      const notifTitle = newStatus === 'collected'
        ? `✅ استحصال مكتمل — ${inv.pharmacyName}`
        : `🔄 استحصال جزئي — ${inv.pharmacyName}`;
      const notifBody = `${repName} استحصل ${finalAmt.toLocaleString()} د.ع من الفاتورة ${inv.invoiceNumber}. المتبقي: ${Math.max(0, remaining).toLocaleString()} د.ع`
        + (returnedAmount > 0 ? ` · استرجاع بضاعة: ${returnedAmount.toLocaleString()} د.ع` : '');

      await prisma.appNotification.createMany({
        data: managers.map(m => ({
          userId: m.id, fromUserId: userId,
          type: notifType, title: notifTitle, body: notifBody,
          data: JSON.stringify({ invoiceId, invoiceNumber: inv.invoiceNumber, amount: finalAmt, remaining, receiptNumber }),
        })),
      });
    }

    res.json({ record, newStatus, remaining: Math.max(0, remaining), receiptNumber });
  } catch (e) { next(e); }
}

// ─── PHARMACIES ──────────────────────────────────────────────
export async function listPharmacies(req, res, next) {
  try {
    const { id: userId } = req.user;
    const pharmacies = await prisma.pharmacy.findMany({
      where: { userId },
      include: { area: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    res.json(pharmacies);
  } catch (e) { next(e); }
}

export async function createPharmacy(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    if (!isMgr(role)) return res.status(403).json({ error: 'Managers only' });
    const { name, ownerName, phone, address, areaId, areaName, notes } = req.body;
    const p = await prisma.pharmacy.create({
      data: {
        name: String(name), ownerName: ownerName ?? null, phone: phone ?? null,
        address: address ?? null, areaId: areaId ? parseInt(areaId) : null,
        areaName: areaName ?? null, notes: notes ?? null, userId,
      },
    });
    res.status(201).json(p);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'صيدلية بهذا الاسم موجودة مسبقاً' });
    next(e);
  }
}

export async function updatePharmacy(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    if (!isMgr(role)) return res.status(403).json({ error: 'Managers only' });
    const id = parseInt(req.params.id);
    const { name, ownerName, phone, address, areaId, areaName, notes, isActive } = req.body;
    const p = await prisma.pharmacy.findFirst({ where: { id, userId } });
    if (!p) return res.status(404).json({ error: 'Not found' });
    const updated = await prisma.pharmacy.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(ownerName != null && { ownerName }),
        ...(phone != null && { phone }),
        ...(address != null && { address }),
        ...(areaId != null && { areaId: parseInt(areaId) }),
        ...(areaName != null && { areaName }),
        ...(notes != null && { notes }),
        ...(isActive != null && { isActive }),
      },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

// ─── PHARMACY VISITS ─────────────────────────────────────────
export async function listVisits(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    const where = isMgr(role) ? { userId } : { userId };
    const visits = await prisma.pharmacyVisit.findMany({
      where,
      include: { items: { include: { item: true } }, area: true },
      orderBy: { visitDate: 'desc' },
      take: 100,
    });
    res.json(visits);
  } catch (e) { next(e); }
}

export async function createVisit(req, res, next) {
  try {
    const { id: userId } = req.user;
    const { pharmacyName, areaId, areaName, visitDate, notes, items = [], latitude, longitude } = req.body;

    // Get linked rep
    const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
    const repId = userRow?.linkedRepId;
    if (!repId) return res.status(400).json({ error: 'لا يوجد مندوب مرتبط بهذا الحساب' });

    const visit = await prisma.pharmacyVisit.create({
      data: {
        pharmacyName: String(pharmacyName),
        areaId: areaId ? parseInt(areaId) : null,
        areaName: areaName ?? null,
        scientificRepId: repId,
        visitDate: visitDate ? new Date(visitDate) : new Date(),
        notes: notes ?? null,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        userId,
        items: items.length ? {
          create: items.map(it => ({
            itemName: String(it.itemName ?? ''),
            notes: it.notes ?? null,
          })),
        } : undefined,
      },
      include: { items: true },
    });
    res.status(201).json(visit);
  } catch (e) { next(e); }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────
export async function listNotifications(req, res, next) {
  try {
    const { id: userId } = req.user;
    const notifs = await prisma.appNotification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const unreadCount = notifs.filter(n => !n.isRead).length;
    res.json({ data: notifs, unreadCount });
  } catch (e) { next(e); }
}

export async function markReadNotification(req, res, next) {
  try {
    const { id: userId } = req.user;
    const id = parseInt(req.params.id);
    if (id === 0) {
      // mark all as read
      await prisma.appNotification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
      return res.json({ success: true });
    }
    const n = await prisma.appNotification.findFirst({ where: { id, userId } });
    if (!n) return res.status(404).json({ error: 'Not found' });
    await prisma.appNotification.update({ where: { id }, data: { isRead: true } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ─── LIST REPS (for manager to assign) ───────────────────────
export async function listCommercialReps(req, res, next) {
  try {
    const { role } = req.user;
    if (!isMgr(role) && !isLead(role)) return res.status(403).json({ error: 'Forbidden' });
    const reps = await prisma.user.findMany({
      where: { role: { in: ['commercial_rep', 'commercial_team_leader', 'commercial_supervisor'] } },
      select: { id: true, username: true, displayName: true, role: true, isActive: true },
      orderBy: { displayName: 'asc' },
    });
    res.json(reps);
  } catch (e) { next(e); }
}

// ─── GENERATE / GET API KEY ───────────────────────────────────
export async function generateApiKey(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    if (!isMgr(role)) return res.status(403).json({ error: 'Managers only' });

    const existing = await prisma.user.findUnique({ where: { id: userId }, select: { apiKey: true } });
    if (existing?.apiKey && req.method === 'GET') return res.json({ apiKey: existing.apiKey });

    // Generate new key
    const key = 'pk_live_' + crypto.randomBytes(28).toString('hex');
    await prisma.user.update({ where: { id: userId }, data: { apiKey: key } });
    res.json({ apiKey: key });
  } catch (e) { next(e); }
}

// ─── WEBHOOK IMPORT (API Key auth — no JWT) ───────────────────
// External ERP calls: POST /api/commercial/invoices/webhook
// Headers: X-Api-Key: pk_live_xxx   OR   Authorization: Bearer pk_live_xxx
// Body: { invoices: [...] } — see schema below
export async function webhookImport(req, res, next) {
  try {
    // req.webhookUser is set by apiKeyAuth middleware
    const managerUser = req.webhookUser;
    const { invoices = [] } = req.body;
    if (!Array.isArray(invoices) || invoices.length === 0)
      return res.status(400).json({ error: 'invoices array is required' });

    const reps = await prisma.user.findMany({
      where: { role: 'commercial_rep' },
      select: { id: true, username: true, displayName: true },
    });
    const normName = s => String(s ?? '').toLowerCase().replace(/\s+/g,'').trim();
    const findRep = name => {
      const n = normName(name);
      return reps.find(r => normName(r.displayName ?? r.username) === n) ??
             reps.find(r => normName(r.displayName ?? r.username).includes(n) || n.includes(normName(r.displayName ?? r.username)));
    };

    let imported = 0;
    const errors = [];
    const unmatched = [];

    for (const inv of invoices) {
      const rep = findRep(inv.repName ?? '');
      if (!rep) { unmatched.push(inv.repName ?? '(فارغ)'); continue; }

      const pharmacyName = String(inv.pharmacyName ?? '').trim();
      if (!inv.invoiceNumber || !pharmacyName) {
        errors.push({ invoiceNumber: inv.invoiceNumber ?? '?', error: 'رقم الفاتورة أو الصيدلية مفقود' });
        continue;
      }

      try {
        const exists = await prisma.commercialInvoice.findFirst({
          where: { invoiceNumber: String(inv.invoiceNumber), userId: managerUser.id, pharmacyName },
        });
        if (exists) { errors.push({ invoiceNumber: inv.invoiceNumber, error: 'موجود مسبقاً' }); continue; }

        const items = Array.isArray(inv.items) ? inv.items.map(it => ({
          brandName:     String(it.brandName ?? it.name ?? '(غير محدد)'),
          scientificName: it.scientificName ?? null,
          dosage:        it.dosage ?? null,
          form:          it.form ?? null,
          unitPrice:     parseFloat(it.unitPrice ?? it.price ?? 0),
          quantity:      parseInt(it.quantity ?? it.qty ?? 1),
          bonusQty:      parseInt(it.bonusQty ?? it.bonus ?? 0),
          totalPrice:    (parseFloat(it.unitPrice ?? 0) || 0) * (parseInt(it.quantity ?? 1) || 1),
        })) : [];
        const totalAmount = items.reduce((s, it) => s + it.totalPrice, 0) || parseFloat(inv.totalAmount ?? 0);

        const invoiceDate     = inv.invoiceDate     ? new Date(inv.invoiceDate)          : new Date();
        const dueDate         = inv.dueDate         ? new Date(inv.dueDate)              : null;
        const maxDate         = inv.maxCollectionDate ? new Date(inv.maxCollectionDate)
          : (dueDate ? new Date(dueDate.getTime() + 7*24*3600*1000) : null);

        await prisma.commercialInvoice.create({
          data: {
            invoiceNumber:     String(inv.invoiceNumber),
            invoiceDate, dueDate, maxCollectionDate: maxDate,
            deferredDays:      inv.deferredDays ? parseInt(inv.deferredDays) : null,
            paymentType:       inv.paymentType ?? 'deferred',
            pharmacyName,
            areaName:          inv.areaName ?? null,
            assignedRepId:     rep.id,
            createdByUserId:   managerUser.id,
            userId:            managerUser.id,
            totalAmount,
            notes:             inv.notes ?? null,
            items: items.length ? { create: items } : undefined,
          },
        });

        // Notify rep
        await prisma.appNotification.create({
          data: {
            userId: rep.id, fromUserId: managerUser.id,
            type: 'invoice_added',
            title: `📄 فاتورة جديدة: ${pharmacyName}`,
            body: `تم إضافة فاتورة رقم ${inv.invoiceNumber} تلقائياً — ${totalAmount.toLocaleString()} د.ع`,
            data: JSON.stringify({ invoiceNumber: inv.invoiceNumber, totalAmount, source: 'webhook' }),
          },
        });
        imported++;
      } catch (err) {
        errors.push({ invoiceNumber: inv.invoiceNumber, error: err.message });
      }
    }

    res.json({ success: true, imported, total: invoices.length, errors, unmatched });
  } catch (e) { next(e); }
}

// ─── FETCH FROM EXTERNAL URL ─────────────────────────────────
// Admin provides a URL → system GETs JSON from it → parses & imports
export async function fetchFromUrl(req, res, next) {
  try {
    const { id: userId, role } = req.user;
    if (!isMgr(role)) return res.status(403).json({ error: 'Managers only' });

    const { url, method = 'GET', headers: extraHeaders = {}, body: reqBody, dryRun = false } = req.body;
    if (!url) return res.status(400).json({ error: 'url مطلوب' });

    // Security: only allow http/https
    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'رابط URL غير صالح' }); }
    if (!['http:', 'https:'].includes(parsed.protocol))
      return res.status(400).json({ error: 'بروتوكول غير مدعوم — استخدم http أو https' });

    // Fetch from external URL
    let rawData;
    try {
      const fetchOpts = {
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...extraHeaders },
      };
      if (reqBody && method.toUpperCase() === 'POST') fetchOpts.body = JSON.stringify(reqBody);

      const resp = await fetch(url, fetchOpts);
      if (!resp.ok) return res.status(502).json({ error: `الخادم الخارجي أعاد: ${resp.status} ${resp.statusText}` });

      const contentType = resp.headers.get('content-type') ?? '';

      // Handle Excel response
      if (contentType.includes('spreadsheet') || contentType.includes('octet-stream') || url.match(/\.(xlsx|xls)(\?|$)/i)) {
        const buf = Buffer.from(await resp.arrayBuffer());
        const wb  = XLSX.read(buf, { type: 'buffer' });
        const ws  = wb.Sheets[wb.SheetNames[0]];
        rawData   = { __excel: true, rows: XLSX.utils.sheet_to_json(ws, { defval: '' }) };
      } else {
        rawData = await resp.json();
      }
    } catch (err) {
      return res.status(502).json({ error: `فشل الاتصال بالخادم الخارجي: ${err.message}` });
    }

    // Normalize to invoices array
    let invoices = [];
    if (rawData?.__excel) {
      // Delegate to Excel import logic — build a temp file and call importInvoices logic
      // For now: convert rows to invoice groups (reuse Excel column mapping from importInvoices)
      const rows = rawData.rows;
      const ALIASES = {
        invoiceNumber:  ['رقمالفاتوره','رقمالفاتورة','invoice','invoicenumber','رقم'],
        pharmacyName:   ['اسمالصيدليه','اسمالصيدلية','pharmacyname','pharmacy','صيدلية','صيدليه'],
        repName:        ['اسمالمندوب','المندوب','rep','repname','مندوب'],
        invoiceDate:    ['تاريخالفاتوره','invoicedate','تاريخ'],
        paymentType:    ['نوعالدفع','نوع'],
        deferredDays:   ['ايامتاجيل','deferreddays'],
        maxDate:        ['اقصىموعد','maxdate'],
        areaName:       ['المنطقه','المنطقة','area'],
        brandName:      ['الاسمالتجاري','brand','brandname'],
        unitPrice:      ['السعر','price','unitprice'],
        quantity:       ['الكميه','الكمية','qty','quantity'],
        bonusQty:       ['بونص','bonus'],
        totalPrice:     ['المجموع','total','totalprice'],
      };
      const normH = s => String(s??'').toLowerCase().replace(/[\u064B-\u065F\s_\-\.]+/g,'').trim();
      const headers = rows[0] ? Object.keys(rows[0]) : [];
      const colMap = {};
      for (const h of headers) {
        const n = normH(h);
        for (const [field, aliases] of Object.entries(ALIASES)) {
          if (!colMap[field] && aliases.some(a => a === n || n.includes(a) || a.includes(n))) { colMap[field] = h; break; }
        }
      }
      const g = (row, f) => colMap[f] != null ? row[colMap[f]] : '';
      const invMap = new Map();
      for (const row of rows) {
        const num = String(g(row,'invoiceNumber')||'').trim();
        if (!num) continue;
        const key = `${num}__${String(g(row,'pharmacyName')||'').trim()}`;
        if (!invMap.has(key)) invMap.set(key, { invoiceNumber: num, rows: [] });
        invMap.get(key).rows.push(row);
      }
      for (const [, inv] of invMap) {
        const first = inv.rows[0];
        invoices.push({
          invoiceNumber: inv.invoiceNumber,
          pharmacyName:  String(g(first,'pharmacyName')||'').trim(),
          repName:       String(g(first,'repName')||'').trim(),
          invoiceDate:   g(first,'invoiceDate') || null,
          paymentType:   normH(g(first,'paymentType')||'').includes('deferred') ? 'deferred' : 'cash',
          deferredDays:  parseInt(g(first,'deferredDays')) || null,
          maxCollectionDate: g(first,'maxDate') || null,
          areaName:      String(g(first,'areaName')||'').trim() || null,
          items: inv.rows.map(row => {
            const up  = parseFloat(g(row,'unitPrice')) || 0;
            const qty = parseInt(g(row,'quantity')) || 1;
            return {
              brandName:  String(g(row,'brandName')||'(غير محدد)').trim(),
              unitPrice:  up,
              quantity:   qty,
              bonusQty:   parseInt(g(row,'bonusQty')) || 0,
              totalPrice: up * qty,
            };
          }),
        });
      }
    } else if (Array.isArray(rawData)) {
      invoices = rawData;
    } else if (Array.isArray(rawData?.invoices)) {
      invoices = rawData.invoices;
    } else if (Array.isArray(rawData?.data)) {
      invoices = rawData.data;
    } else {
      return res.status(422).json({
        error: 'صيغة البيانات غير مدعومة',
        hint: 'يجب أن يرجع الـ API مصفوفة invoices[] أو data[] أو مصفوفة مباشرة',
        received: typeof rawData,
      });
    }

    if (dryRun) return res.json({ success: true, preview: invoices.slice(0, 5), total: invoices.length });

    // Reuse webhook import logic
    req.webhookUser = await prisma.user.findUnique({ where: { id: userId } });
    req.body = { invoices };
    return webhookImport(req, res, next);
  } catch (e) { next(e); }
}

// ─── API KEY AUTH MIDDLEWARE ──────────────────────────────────
// Used in routes for webhook endpoint (no JWT)
export async function apiKeyAuth(req, res, next) {
  try {
    const key = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
    if (!key) return res.status(401).json({ error: 'X-Api-Key header مطلوب' });
    if (!key.startsWith('pk_live_')) return res.status(401).json({ error: 'مفتاح API غير صالح' });

    const user = await prisma.user.findUnique({ where: { apiKey: key } });
    if (!user || !user.isActive) return res.status(401).json({ error: 'مفتاح API غير صالح أو الحساب غير نشط' });
    if (!isMgr(user.role)) return res.status(403).json({ error: 'هذا المفتاح لا يملك صلاحية استيراد الفواتير' });

    req.webhookUser = user;
    next();
  } catch (e) { next(e); }
}

