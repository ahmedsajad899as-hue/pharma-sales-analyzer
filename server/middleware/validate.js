/**
 * DTO Validation Middleware
 *
 * Usage:
 *   router.post('/route', validate(MySchema), controller)
 *
 * Schemas are plain objects with a `parse(data)` method (compatible
 * with Zod schemas). A lightweight built-in implementation is also
 * provided via `createSchema()` for cases without Zod.
 */

import { AppError } from './errorHandler.js';

/**
 * Express middleware factory — validates req.body against a schema.
 * @param {Object} schema - Object with a parse(data) method (Zod-compatible)
 * @param {'body'|'query'|'params'} source
 */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      const result = schema.parse(req[source]);
      req[source] = result; // replace with sanitized/coerced values
      next();
    } catch (err) {
      // Zod validation error
      if (err.errors) {
        const details = err.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        return res.status(422).json({
          success: false,
          code: 'VALIDATION_ERROR',
          message: 'Validation failed.',
          details,
        });
      }
      next(new AppError(err.message, 422, 'VALIDATION_ERROR'));
    }
  };
}
