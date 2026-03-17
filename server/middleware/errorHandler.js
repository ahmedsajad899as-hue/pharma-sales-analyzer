/**
 * Global Error Handler Middleware
 * Catches all errors thrown from controllers/services and returns
 * a structured JSON response.
 */

export class AppError extends Error {
  /**
   * @param {string} message  - Human-readable message
   * @param {number} statusCode - HTTP status code
   * @param {string} code - Machine-readable error code
   */
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Express error-handling middleware (4 args required)
 */
export function errorHandler(err, req, res, _next) {
  // Prisma known errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      code: 'DUPLICATE_ENTRY',
      message: `Duplicate value on field: ${err.meta?.target?.join(', ')}`,
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      code: 'NOT_FOUND',
      message: 'Record not found.',
    });
  }

  // Operational (known) errors
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
    });
  }

  // Unexpected errors
  console.error('[Unhandled Error]', err);
  const isDev = process.env.NODE_ENV !== 'production';
  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: isDev ? (err?.message || 'An unexpected error occurred.') : 'An unexpected error occurred.',
    ...(isDev && err?.code ? { prismaCode: err.code } : {}),
  });
}
