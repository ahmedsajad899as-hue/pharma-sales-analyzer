/**
 * Representatives DTOs — Zod validation schemas.
 * Install zod: npm install zod
 */

import { z } from 'zod';

// ─── Create Representative ────────────────────────────────────
export const CreateRepresentativeDTO = z.object({
  name:  z.string().min(2).max(100).trim(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
});

// ─── Update Representative ────────────────────────────────────
export const UpdateRepresentativeDTO = z.object({
  name:     z.string().min(2).max(100).trim().optional(),
  phone:    z.string().max(20).optional(),
  email:    z.string().email().optional(),
  isActive: z.boolean().optional(),
});

// ─── Assign Areas ─────────────────────────────────────────────
export const AssignAreasDTO = z.object({
  areaIds: z.array(z.number().int().positive()).min(1, 'At least one area required'),
});

// ─── Assign Items ─────────────────────────────────────────────
export const AssignItemsDTO = z.object({
  itemIds: z.array(z.number().int().positive()).min(1, 'At least one item required'),
});

// ─── Report Query Params ──────────────────────────────────────
export const ReportQueryDTO = z.object({
  startDate: z.string().datetime().optional(),
  endDate:   z.string().datetime().optional(),
  areaId:    z.coerce.number().int().positive().optional(),
  itemId:    z.coerce.number().int().positive().optional(),
});
