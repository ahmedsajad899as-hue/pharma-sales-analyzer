import prisma from '../../lib/prisma.js';

// ── helper: resolve scientificRepId from JWT user ─────────────
async function resolveRepId(userId) {
  const rep = await prisma.scientificRepresentative.findFirst({
    where: {
      OR: [
        { userId },
        { linkedUsers: { some: { id: userId } } },
      ],
    },
    select: { id: true },
  });
  return rep?.id ?? null;
}

const MANAGER_ROLES = ['admin', 'manager', 'office_manager', 'supervisor', 'scientific_supervisor'];

// ── POST /api/tracking/location ───────────────────────────────
// Body: { latitude, longitude, accuracy?, workDate? }
export async function saveLocation(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'غير مصرح' });

    const { latitude, longitude, accuracy, workDate } = req.body;
    if (latitude == null || longitude == null)
      return res.status(400).json({ error: 'الإحداثيات مطلوبة' });

    const repId = await resolveRepId(userId);
    if (!repId) return res.status(403).json({ error: 'حساب المندوب غير موجود' });

    const today = workDate || new Date().toISOString().slice(0, 10);

    const point = await prisma.repLocationPoint.create({
      data: {
        scientificRepId: repId,
        latitude:  parseFloat(latitude),
        longitude: parseFloat(longitude),
        accuracy:  accuracy != null ? parseFloat(accuracy) : null,
        workDate:  today,
      },
    });

    res.json({ success: true, id: point.id });
  } catch (err) {
    console.error('[tracking] saveLocation error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
}

// ── GET /api/tracking/locations?repId=&date= ──────────────────
// Managers can query any repId; reps can only see their own.
export async function getLocations(req, res) {
  try {
    const userId   = req.user?.id;
    const userRole = req.user?.role || '';
    const { repId, date } = req.query;

    const isManager = MANAGER_ROLES.includes(userRole);

    let targetRepId;

    if (repId && isManager) {
      targetRepId = parseInt(repId, 10);
    } else {
      targetRepId = await resolveRepId(userId);
      if (!targetRepId) return res.status(403).json({ error: 'حساب المندوب غير موجود' });
    }

    const workDate = date || new Date().toISOString().slice(0, 10);

    const points = await prisma.repLocationPoint.findMany({
      where: { scientificRepId: targetRepId, workDate },
      orderBy: { trackedAt: 'asc' },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        accuracy: true,
        trackedAt: true,
      },
    });

    res.json({ success: true, points, workDate, repId: targetRepId });
  } catch (err) {
    console.error('[tracking] getLocations error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
}

// ── DELETE /api/tracking/locations?repId=&date= ───────────────
// Managers only — delete all tracking points for a rep+date.
export async function deleteLocations(req, res) {
  try {
    const userRole = req.user?.role || '';
    if (!MANAGER_ROLES.includes(userRole))
      return res.status(403).json({ error: 'غير مصرح' });

    const { repId, date } = req.query;
    if (!repId || !date) return res.status(400).json({ error: 'repId وdate مطلوبان' });

    const { count } = await prisma.repLocationPoint.deleteMany({
      where: { scientificRepId: parseInt(repId, 10), workDate: date },
    });

    res.json({ success: true, deleted: count });
  } catch (err) {
    console.error('[tracking] deleteLocations error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
}
