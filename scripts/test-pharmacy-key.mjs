// اختبار مفتاح مطابقة أسماء الصيدليات + اقتراحات الدمج.
// تشغيل: npm run test:pharmacy-key
import assert from 'node:assert/strict';
import { pharmacyKey } from '../server/lib/pharmacyKey.js';
import { suggestPharmacyMerges } from '../server/lib/pharmacyResolver.js';

// 1) الأسماء التي هي صيدلية واحدة يجب أن تتطابق مفاتيحها
const same = ['صيدلية الامل', 'الامل', 'ص. الامل', 'صيدلية الأمل', 'الصيدلية الامل', 'ص/الامل'];
const k = pharmacyKey(same[0]);
for (const n of same) assert.equal(pharmacyKey(n), k, `"${n}" يجب أن يطابق "${same[0]}"`);
assert.equal(k, 'امل');

// 2) التاء المربوطة والياء والتشكيل والتطويل لا تفرّق
assert.equal(pharmacyKey('صيدلية نور الهدَى'), pharmacyKey('نور الهدي'));
assert.equal(pharmacyKey('الـبـشـيـر'), pharmacyKey('البشير'));

// 3) الصيدليات المختلفة تبقى مختلفة (لا احتواء)
assert.notEqual(pharmacyKey('نور'), pharmacyKey('نور الهدى'));
assert.notEqual(pharmacyKey('الامل'), pharmacyKey('الامل الجديدة'));

// 4) أسماء عامة فقط تُختزل إلى مفتاح فارغ (يتولاها المسار الاحتياطي في scoped-sales)
assert.equal(pharmacyKey('الصيدلية'), '');
assert.equal(pharmacyKey('ص / مكتب'), '');

// 5) اقتراحات الدمج: تشابه كلمات قوي فقط، ولا اقتراح لصيدليات متباعدة
const groups = [
  { key: 'امل', name: 'الامل', orders: 10, value: 1000 },
  { key: 'امل جديده', name: 'الامل الجديدة', orders: 4, value: 400 },
  { key: 'نور', name: 'نور', orders: 3, value: 300 },
  { key: 'نور الهدي', name: 'نور الهدى', orders: 7, value: 700 },
  { key: 'بغداد', name: 'بغداد', orders: 9, value: 900 },
];
const sug = suggestPharmacyMerges(groups);
const pairs = sug.map(s => [s.a.key, s.b.key].sort().join('|')).sort();
assert.deepEqual(pairs, ['امل|امل جديده', 'نور|نور الهدي']);
assert.ok(sug.every(s => s.score >= 0.5));

console.log('test-pharmacy-key: OK');
