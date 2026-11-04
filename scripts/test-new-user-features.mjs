// قائمة مميزات الحساب الجديد مقابل مفاتيح featureConfig.ts — npm run test:new-user-features
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NEW_USER_KEPT_FEATURES, NEW_USER_ENABLED_OPT_IN, NEW_USER_DISABLED_FEATURES, newUserPermissions,
} from '../server/lib/newUserFeatures.js';

const src = readFileSync(new URL('../src/config/featureConfig.ts', import.meta.url), 'utf8');
const between = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const pageKeys = [...between('export const FEATURE_PAGE_MAP', '};').matchAll(/^\s*(\w+):\s*'/gm)].map(m => m[1]);
const nodeKeys = [...src.matchAll(/\bkey:\s*'(\w+)'/g)].map(m => m[1]);
const optIn = new Set([...between('export const OPT_IN_FEATURES', ']);').matchAll(/'(\w+)'/g)].map(m => m[1]));
const allKeys = new Set([...pageKeys, ...nodeKeys]);
assert.ok(allKeys.size > 50 && optIn.size > 5, 'تعذّرت قراءة مفاتيح featureConfig.ts');

const disabled = new Set(NEW_USER_DISABLED_FEATURES);
const kept = new Set(NEW_USER_KEPT_FEATURES);

const missing = [...allKeys].filter(k => !optIn.has(k) && !kept.has(k) && !disabled.has(k));
assert.deepEqual(missing, [], 'ميزة عادية غير مصنَّفة ستكون مفعّلة لكل حساب جديد');

const stale = [...disabled, ...kept, ...NEW_USER_ENABLED_OPT_IN].filter(k => !allKeys.has(k));
assert.deepEqual(stale, [], 'مفتاح لم يعد موجوداً في featureConfig.ts');

assert.deepEqual(NEW_USER_DISABLED_FEATURES.filter(k => optIn.has(k) || kept.has(k)), [], 'مفتاح معطَّل ومفعَّل معاً');
assert.equal(disabled.size, NEW_USER_DISABLED_FEATURES.length, 'مفتاح مكرر');
assert.ok(NEW_USER_ENABLED_OPT_IN.every(k => optIn.has(k)));

// نفس قرار isFeatureEnabled في الواجهة، على صلاحيات الحساب الجديد
const perms = newUserPermissions();
const isOn = (k) => !perms.disabledFeatures.includes(k) && (!optIn.has(k) || perms.enabledFeatures.includes(k));
const on = [...allKeys].filter(isOn).sort();
assert.deepEqual(on, ['call_log', 'daily_map', 'dashboard_page', 'home_page', 'rep_orders']);

console.log(`✓ ${allKeys.size} مفتاحاً مصنَّفاً؛ المفعَّل لحساب جديد: ${on.join(', ')}`);
