/**
 * Sales DTOs — Zod validation schemas for the sales module.
 * Install zod: npm install zod
 */

import { z } from 'zod';

// ─── Upload Sales DTO ─────────────────────────────────────────
// Validates the optional query/body metadata sent alongside the file upload.
export const UploadSalesMetaDTO = z.object({
  uploadedBy: z.string().max(100).optional(),
});

// ─── Column Mapping DTO ───────────────────────────────────────
// Allows the client to specify which Excel column maps to which field.
export const ColumnMappingDTO = z.object({
  repName:    z.string().default('Representative Name'),
  area:       z.string().default('Area'),
  item:       z.string().default('Item'),
  quantity:   z.string().default('Quantity'),
  totalValue: z.string().default('Total Value'),
  customer:   z.string().default('Customer').optional(),
  date:       z.string().default('Date').optional(),
}).optional().default({});

// ─── Parsed Excel Row (internal) ──────────────────────────────
export const ExcelRowSchema = z.object({
  repName:    z.string().min(1, 'Representative name is required'),
  area:       z.string().min(1, 'Area is required'),
  item:       z.string().min(1, 'Item is required'),
  quantity:   z.number().nonnegative('Quantity must be >= 0'),
  totalValue: z.number().nonnegative('Total value must be >= 0'),
  customer:   z.string().optional(),   // optional: pharmacy / clinic / hospital name
  date:       z.date().optional(),     // optional: parsed sale date from Excel
  rawData:    z.string().optional(),   // full original Excel row as JSON string
});

