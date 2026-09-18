// One-off cleanup after unifying the stock ledger (server/lib/stockLedgerScope.js).
//
// Until 2026-09-18 every office_employee stock upload (baseline / in / out / manual)
// was RE-INGESTED into the account of every office_manager / office_hr /
// company_manager, giving each of them an independent copy that drifted from the
// employee's ledger. Managers now read the employees' ledgers directly, so those
// copies would double-count. This script deletes the copies ("mirrors") and
// recomputes the affected balances.
//
// A mirror is a manager batch that has an office_employee batch with the SAME
// kind + name + movementDate, uploaded within MIRROR_WINDOW_MS of it (the sync
// ran inside the same HTTP request, so the two uploadedAt values are seconds
// apart). Anything else in a manager account is that manager's own upload and is
// left untouched — it is listed in the report so the user can decide.
//
//   node scripts/cleanup-stock-ledger-mirrors.mjs            # report only
//   node scripts/cleanup-stock-ledger-mirrors.mjs --apply    # delete + recompute
import { PrismaClient } from '@prisma/client';
import { recomputeBalances } from '../server/modules/stock-ledger/stock-ledger.service.js';

const APPLY = process.argv.includes('--apply');
const MIRROR_WINDOW_MS = 15 * 60 * 1000;
const VIEWER_ROLES = ['office_manager', 'office_hr', 'company_manager'];

const p = new PrismaClient();
const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');
const key = (b) => `${b.kind}|${b.name}|${new Date(b.movementDate).toISOString()}`;

try {
  const [viewers, employees] = await Promise.all([
    p.user.findMany({ where: { role: { in: VIEWER_ROLES } }, select: { id: true, username: true, displayName: true, role: true } }),
    p.user.findMany({ where: { role: 'office_employee' }, select: { id: true } }),
  ]);
  const employeeIds = employees.map(e => e.id);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — viewers: ${viewers.length}, office employees: ${employeeIds.length}`);

  const employeeBatches = employeeIds.length
    ? await p.stockMovementBatch.findMany({ where: { userId: { in: employeeIds } } })
    : [];
  const byKey = new Map();
  for (const b of employeeBatches) {
    if (!byKey.has(key(b))) byKey.set(key(b), []);
    byKey.get(key(b)).push(b);
  }

  let totalMirrors = 0;
  for (const v of viewers) {
    const batches = await p.stockMovementBatch.findMany({ where: { userId: v.id }, orderBy: { uploadedAt: 'asc' } });
    if (!batches.length) continue;
    const mirrors = [], own = [];
    for (const b of batches) {
      const twins = byKey.get(key(b)) ?? [];
      const isMirror = twins.some(t => Math.abs(new Date(t.uploadedAt) - new Date(b.uploadedAt)) <= MIRROR_WINDOW_MS);
      (isMirror ? mirrors : own).push(b);
    }
    console.log(`\n▪ ${v.displayName || v.username} (#${v.id}, ${v.role}) — ${batches.length} batch(es): ${mirrors.length} mirror(s), ${own.length} own`);
    for (const b of mirrors) console.log(`    mirror  ${b.kind.padEnd(8)} ${fmt(b.movementDate)}  rows=${b.rowCount}  ${b.name}`);
    for (const b of own)     console.log(`    OWN     ${b.kind.padEnd(8)} ${fmt(b.movementDate)}  rows=${b.rowCount}  ${b.name}  (uploaded ${fmt(b.uploadedAt)})`);
    totalMirrors += mirrors.length;

    if (APPLY && mirrors.length) {
      const ids = mirrors.map(b => b.id);
      const whRows = await p.stockMovement.findMany({ where: { batchId: { in: ids } }, select: { warehouseId: true }, distinct: ['warehouseId'] });
      await p.stockMovementBatch.deleteMany({ where: { id: { in: ids }, userId: v.id } }); // cascades movements + order lines
      const pairs = await recomputeBalances(v.id, whRows.map(r => r.warehouseId));
      console.log(`    → deleted ${ids.length} mirror batch(es), recomputed ${pairs} balance row(s)`);
    }
  }
  console.log(`\n${APPLY ? 'Deleted' : 'Would delete'} ${totalMirrors} mirror batch(es) in total.${APPLY ? '' : ' Re-run with --apply to delete.'}`);
} finally {
  await p.$disconnect();
}
