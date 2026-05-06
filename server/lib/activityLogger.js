/**
 * Activity Logger
 * Logs user actions to the activity_logs table.
 * Call logActivity() from controllers — never throws.
 */

import prisma from './prisma.js';

// ── Global on/off switch (survives process lifetime, resets on redeploy) ──
// Persisted in DB via a lightweight key-value using existing User permissions hack:
// we store it in a special "system" record, but for simplicity we use a module-level
// flag that is loaded from DB on first use and can be toggled via API.
let _globalLoggingEnabled = true;  // default ON
let _globalFlagLoaded = false;

export async function loadGlobalLoggingFlag() {
  try {
    const sys = await prisma.activityLog.findFirst({
      where: { module: '__system__', action: 'activity_logging_disabled' },
      orderBy: { createdAt: 'desc' },
    });
    _globalLoggingEnabled = !sys; // if record exists → disabled
    _globalFlagLoaded = true;
  } catch { _globalFlagLoaded = true; }
}

export function isGlobalLoggingEnabled() { return _globalLoggingEnabled; }

export async function setGlobalLogging(enabled) {
  _globalLoggingEnabled = enabled;
  if (!enabled) {
    // Store a sentinel record to persist across restarts
    await prisma.activityLog.deleteMany({ where: { module: '__system__', action: 'activity_logging_disabled' } });
    await prisma.activityLog.create({ data: { module: '__system__', action: 'activity_logging_disabled', userId: null } });
  } else {
    await prisma.activityLog.deleteMany({ where: { module: '__system__', action: 'activity_logging_disabled' } });
  }
}

/**
 * Log a user action.
 * @param {{ userId?: number|null, action: string, module?: string, details?: string, req?: import('express').Request }} opts
 */
export async function logActivity({ userId = null, action, module = null, details = null, req = null }) {
  try {
    const ipAddress = req
      ? (req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ?? req.socket?.remoteAddress ?? null)
      : null;
    await prisma.activityLog.create({
      data: {
        userId:    userId ?? null,
        action,
        module:    module ?? null,
        details:   details ? String(details).slice(0, 1000) : null,
        ipAddress: ipAddress ?? null,
      },
    });
  } catch (_) {
    // Never crash the request over logging
  }
}

/**
 * Express middleware — logs every authenticated request automatically.
 * Uses res.on('finish') so controllers can set req._skipActivity = true
 * or req._activityDetails = '...' before the response ends.
 */
export function activityMiddleware(req, res, next) {
  // Load global flag once on first request
  if (!_globalFlagLoaded) { loadGlobalLoggingFlag(); }

  res.on('finish', () => {
    if (req.method === 'GET') return;          // skip read-only
    if (!req.user) return;                     // skip unauthenticated
    if (req._skipActivity) return;             // controller already logged explicitly

    // ── Global kill switch ──
    if (!_globalLoggingEnabled) return;

    // ── Per-user kill switch ──
    try {
      const perms = JSON.parse(req.user.permissions || '{}');
      if (perms.disableActivityLog === true) return;
    } catch {}

    const fullPath = (req.originalUrl || req.path).split('?')[0];
    const parts    = fullPath.split('/').filter(Boolean);
    // parts: ['api', 'monthly-plans', '5']  →  module = parts[1]
    const module   = parts[1] || parts[0] || 'unknown';

    // Capture any name-like field from the parsed body
    const body = req.body || {};
    const nameHint = body.name || body.title || body.displayName ||
                     body.pharmacyName || body.username || null;

    // Month/year hint for plans
    const monthHint = (body.month && body.year)
      ? `شهر ${body.month}/${body.year}` : null;

    // Entity ID from path tail
    const lastSeg  = parts[parts.length - 1];
    const idHint   = (!nameHint && !monthHint && /^\d+$/.test(lastSeg)) ? `#${lastSeg}` : null;

    const details = req._activityDetails
      || [nameHint, monthHint].filter(Boolean).join(' — ')
      || idHint
      || null;

    logActivity({
      userId:  req.user.id,
      action:  `${req.method} ${fullPath}`,
      module,
      details,
      req,
    });
  });
  next();
}
