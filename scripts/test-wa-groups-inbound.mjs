// ════════════════════════════════════════════════════════════════════════════
// اختبار استقبال كروبات واتساب الصامتة — تشغيل: npm run test:wa-groups
// ────────────────────────────────────────────────────────────────────────────
// الكروب صامت، فأي رسالة تضيع هنا لا يعلم بها أحد: لا ردّ ولا خطأ يظهر للمندوب.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  shouldHandleUpsert, messageTimeMs, createSeenStore, forwardWithRetry, MAX_OFFLINE_AGE_MS,
} from '../server/wa-groups-sidecar/inbound-guard.js';
import { retryable, shouldDeferForFullQueue, QUEUE_FULL_CODE } from '../server/modules/wa-groups/listen-retry.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`✗ ${label}\n    نتيجة: ${JSON.stringify(actual)}\n    متوقَّع: ${JSON.stringify(expected)}`); }
  else console.log(`✓ ${label}`);
};

// ── 1) رسائل الانقطاع ───────────────────────────────────────────────────────
const NOW = 1_800_000_000_000;
const at = (msAgo) => ({ messageTimestamp: Math.floor((NOW - msAgo) / 1000) });

check('المباشرة تُعالَج دائماً', shouldHandleUpsert('notify', {}, NOW), true);
check('رسالة انقطاع حديثة تُعالَج (كانت تضيع)', shouldHandleUpsert('append', at(60_000), NOW), true);
check('رسالة انقطاع عند حدّ العمر تُعالَج', shouldHandleUpsert('append', at(MAX_OFFLINE_AGE_MS), NOW), true);
check('رسالة أقدم من الحدّ لا تُقرأ', shouldHandleUpsert('append', at(MAX_OFFLINE_AGE_MS + 5000), NOW), false);
check('رسالة انقطاع بلا طابع وقت لا تُقرأ', shouldHandleUpsert('append', {}, NOW), false);
check('نوع غير معروف لا يُقرأ', shouldHandleUpsert('other', at(1000), NOW), false);
check('الطابع بصيغة Long', messageTimeMs({ messageTimestamp: { toNumber: () => 1700 } }), 1_700_000);
check('الطابع بصيغة كائن low', messageTimeMs({ messageTimestamp: { low: 1700, high: 0 } }), 1_700_000);

// ── 2) سجلّ المعالَج: لا قراءة مرتين، ويبقى بعد إعادة التشغيل ──────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-seen-'));
  const file = path.join(dir, 'nested', 'seen.json');
  let t = NOW;
  const now = () => t;
  const a = createSeenStore(file, { ttlMs: 1000, now });
  check('جديدة غير معروفة', a.has('m1'), false);
  a.add('m1');
  check('بعد الإضافة معروفة', a.has('m1'), true);
  check('تبقى بعد إعادة التشغيل', createSeenStore(file, { ttlMs: 1000, now }).has('m1'), true);
  a.add('m2');
  a.delete('m2');
  check('الحذف عند فشل التمرير يسمح بالإعادة', createSeenStore(file, { ttlMs: 1000, now }).has('m2'), false);
  t += 2000;
  check('تنتهي بعد المدة', a.has('m1'), false);
  a.add('m3');
  check('المنتهية تُحذف من الملف', Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['m3']);
  check('معرّف مثل constructor ليس معروفاً', createSeenStore(file, { ttlMs: 1000, now }).has('constructor'), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 3) التمرير للتطبيق: إعادة تشغيل وقت النشر لا تُضيّع الرسالة ─────────────
const run = async (script, delays = [1, 2, 3]) => {
  const slept = [];
  let i = 0;
  const ok = await forwardWithRetry(async () => {
    const step = script[i++];
    if (step instanceof Error) throw step;
    return { ok: step < 400, status: step };
  }, { delays, sleep: async (ms) => { slept.push(ms); } });
  return { ok, calls: i, slept };
};
check('ينجح من أول مرة بلا انتظار', await run([200]), { ok: true, calls: 1, slept: [] });
check('التطبيق يعيد التشغيل ثم يعود', await run([new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), 200]), { ok: true, calls: 3, slept: [1, 2] });
check('5xx يُعاد', await run([502, 200]), { ok: true, calls: 2, slept: [1] });
check('الرفض 403 لا يُعاد', await run([403]), { ok: false, calls: 1, slept: [] });
check('الفشل المستمر ينتهي بعد المحاولات', await run([500, 500, 500, 500]), { ok: false, calls: 4, slept: [1, 2, 3] });

// ── 4) امتلاء طابور المراجعة ────────────────────────────────────────────────
const op = (code, statusCode) => Object.assign(new Error('x'), { code, statusCode, isOperational: true });
check('الطابور الممتلئ يُعاد (كان يُرفض نهائياً)', retryable(op(QUEUE_FULL_CODE, 409)), true);
check('5xx يُعاد', retryable(op('AI', 502)), true);
check('خطأ غير متوقّع يُعاد', retryable(new Error('boom')), true);
check('مدخل مرفوض 422 لا يُعاد', retryable(op('NO_ORDER_ROWS', 422)), false);

const defer = (o) => shouldDeferForFullQueue({ mode: 'all', hasMedia: false, pending: 300, limit: 300, ...o });
const ORDER = 'صيدلية النور بانادول 5 علبة';
check('تحت الحدّ لا تأجيل', defer({ text: ORDER, pending: 299 }), false);
check('طلبية نص عند الامتلاء تُؤجَّل قبل القراءة', defer({ text: ORDER }), true);
check('صورة عند الامتلاء تُؤجَّل', defer({ text: '', hasMedia: true }), true);
check('دردشة عند الامتلاء لا تُؤجَّل', defer({ text: 'مرحبا شلونكم' }), false);
check('الكروب المطفأ لا يُؤجَّل', defer({ text: ORDER, mode: 'off' }), false);

if (failed) { console.log(`\n✗ فشل ${failed}`); process.exit(1); }
console.log('\n✓ كل الاختبارات نجحت');
