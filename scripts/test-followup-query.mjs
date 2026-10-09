// اختبار محلّل سؤال المتابعة بالبوت. npm run test:followup-query
import { parseFollowupQuery } from '../server/modules/rep-followup/followup-query-trigger.js';

let fails = 0;
const THIS_YEAR = new Date().getFullYear();

const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log('FAIL', label, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', label);
};

const q = (name, month = null, { year = THIS_YEAR, qualifier = null, self = false } = {}) =>
  ({ repNameRaw: name, month, year, qualifier, self });

// ── يُطابق ────────────────────────────────────────────────────────────────
eq('متابعة + اسم', parseFollowupQuery('متابعة محمد باقر'), q('محمد باقر'));
eq('الاسم قبل الكلمة', parseFollowupQuery('محمد باقر متابعة'), q('محمد باقر'));
eq('تقييم + اسم', parseFollowupQuery('تقييم احمد الكاظمي'), q('احمد الكاظمي'));
eq('مستوى + اسم', parseFollowupQuery('مستوى علي حسن'), q('علي حسن'));
eq('مع شهر', parseFollowupQuery('متابعة محمد باقر شهر 9'), q('محمد باقر', 9));
eq('مع شهر وسنة', parseFollowupQuery('متابعة محمد باقر شهر 9 2025'), q('محمد باقر', 9, { year: 2025 }));
eq('أرقام عربية', parseFollowupQuery('متابعة محمد شهر ٩'), q('محمد', 9));
eq('مؤهِّل الشركة بعد الشهر', parseFollowupQuery('متابعة محمد شهر 9 البلسم'), q('محمد', 9, { qualifier: 'البلسم' }));
eq('إشارة استفهام تُنزع', parseFollowupQuery('متابعة محمد باقر؟'), q('محمد باقر'));
eq('«عن» تُنزع', parseFollowupQuery('متابعة عن محمد باقر'), q('محمد باقر'));
eq('«المتابعة» بأل التعريف', parseFollowupQuery('المتابعة محمد باقر'), q('محمد باقر'));
eq('«متابعه» بالهاء', parseFollowupQuery('متابعه محمد باقر'), q('محمد باقر'));

// ── صيغ «عن نفسي» ────────────────────────────────────────────────────────
eq('متابعتي', parseFollowupQuery('متابعتي'), q(null, null, { self: true }));
eq('تقييمي شهر 8', parseFollowupQuery('تقييمي شهر 8'), q(null, 8, { self: true }));
eq('مستواي', parseFollowupQuery('مستواي'), q(null, null, { self: true }));
eq('«متابعة» وحدها = عن نفسي', parseFollowupQuery('متابعة'), q(null, null, { self: true }));

// ── لا يُطابق ────────────────────────────────────────────────────────────
eq('نص بلا كلمة متابعة', parseFollowupQuery('شلونك اليوم'), null);
eq('فراغ', parseFollowupQuery(''), null);
eq('null', parseFollowupQuery(null), null);
// سؤال المبيعات له مساره — لا يُجاب عليه مرتين
eq('سؤال مبيعات صريح', parseFollowupQuery('متابعة محمد مبيع شهر 9'), null);
eq('مبيع بلا متابعة', parseFollowupQuery('محمد باقر مبيع شهر 9'), null);
// طلبية حقيقية لا تحوي كلمات المتابعة
eq('طلبية', parseFollowupQuery('طلبية صيدلية النور بانادول 5 علبة'), null);
eq('نص طويل ليس سؤالاً', parseFollowupQuery('متابعة ' + 'ا'.repeat(400)), null);
// شهر غير صالح يُتجاهل كشهر ويبقى السؤال صالحاً
eq('شهر 13 يُتجاهل', parseFollowupQuery('متابعة محمد شهر 13'), q('محمد شهر 13'));

console.log(fails ? `\n❌ فشل ${fails} اختبار` : '\n✅ كل الاختبارات نجحت');
process.exit(fails ? 1 : 0);
