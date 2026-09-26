// One-off backfill: populate Sale.customerInfoNorm for rows uploaded BEFORE the
// "block by substring inside معلومات الزبون" feature existed. Those rows already
// carry the column's raw value inside rawData (the full original Excel row was
// always stored) — this just re-extracts it into the new dedicated column so the
// new block feature works on already-uploaded files, not only future uploads.
// Safe to re-run: only touches rows where customerInfoNorm is still null.
import { PrismaClient } from '@prisma/client';

const CUSTOMER_INFO_ALIASES = [
  'معلومات الزبون', 'معلومات العميل', 'بيانات الزبون', 'بيانات العميل',
  'تفاصيل الزبون', 'تفاصيل العميل', 'وصف الزبون', 'وصف العميل',
  'customer info', 'customer information', 'customer details',
].map(a => a.toLowerCase());

// Copy of normalizeArabic from server/modules/sales/sales.repository.js — kept
// inline so this throwaway script has no dependency on the app's module graph.
function normalizeArabic(str) {
  return String(str)
    .trim()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ـ/g, '')
    .replace(/[ً-ٟ]/g, '')
    .replace(/[-–—,،/\\]+/g, ' ')
    .replace(/(^|\s)ال/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCustomerInfoNorm(rawData) {
  if (!rawData) return null;
  let raw;
  try { raw = JSON.parse(rawData); } catch { return null; }
  for (const key of Object.keys(raw)) {
    if (CUSTOMER_INFO_ALIASES.includes(String(key).toLowerCase().trim())) {
      const v = String(raw[key] ?? '').trim();
      if (v) return normalizeArabic(v);
    }
  }
  return null;
}

const p = new PrismaClient();
const BATCH = 5000;
const CONCURRENCY = 20;

try {
  let cursor = 0;
  let scanned = 0;
  let updated = 0;
  for (;;) {
    const rows = await p.sale.findMany({
      where: { id: { gt: cursor }, customerInfoNorm: null, rawData: { not: null } },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { id: true, rawData: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;

    const toUpdate = rows
      .map(r => ({ id: r.id, norm: extractCustomerInfoNorm(r.rawData) }))
      .filter(r => r.norm);

    for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
      const chunk = toUpdate.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(r => p.sale.update({ where: { id: r.id }, data: { customerInfoNorm: r.norm } })));
      updated += chunk.length;
    }
    console.log(`scanned ${scanned} rows so far (up to id=${cursor}), updated ${updated}...`);
  }
  console.log(`Done. scanned=${scanned} updated=${updated}`);
} catch (e) {
  console.error('ERR:', e.message);
} finally {
  await p.$disconnect();
}
