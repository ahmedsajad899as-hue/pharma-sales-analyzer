/**
 * Activity Logger
 * Logs user actions to the activity_logs table.
 * Call logActivity() from controllers — never throws.
 */

import prisma from './prisma.js';

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
 * Lightweight: only logs method + path; skips GET requests to reduce noise.
 */
export function activityMiddleware(req, res, next) {
  next();
  if (req.method === 'GET') return; // skip read-only
  if (!req.user) return;            // skip unauthenticated
  const module = req.path.split('/')[2] || 'unknown'; // e.g. /api/visits → visits
  logActivity({
    userId:  req.user.id,
    action:  `${req.method} ${req.path}`,
    module,
    details: null,
    req,
  });
}
