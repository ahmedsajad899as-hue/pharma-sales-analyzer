// ════════════════════════════════════════════════════════════════════════════
// followup-query.js — يجيب على «متابعة محمد باقر» في كروب تلكرام.
//
// يقرأ **اللقطة المحفوظة** ويبني نفس نصّ الملخّص اليومي (formatRepDigest)، فما
// يقرأه المدير في البوت هو حرفياً ما يراه في الصفحة وما يستلمه المندوب — لا
// حاسب ثالث. ولا يُطلق حساباً جديداً: حساب فريق كامل على رسالة كروب كان سيُشعل
// الخادم من رسالة واحدة.
//
// حارس خصوصية: مطابقة الاسم متاحة للمدراء فقط. المندوب الميداني يستلم تقييمه هو
// دائماً مهما كتب — بلا هذا الحارس كان يقرأ تقييم زميله، لأن اللقطات كلها تحت
// ownerUserId واحد (حساب المدير).
// ════════════════════════════════════════════════════════════════════════════

import * as sciRepSvc from '../scientific-reps/scientific-reps.service.js';
import { buildRepIndex, matchRepName } from '../../lib/repNameMatch.js';
import { resolveDocOwnerUserId } from '../doctors/doctors.controller.js';
import { getStandards } from '../../lib/followupStandards.js';
import { getSnapshotsForViewer, getSnapshotForViewerRep, periodKeyOf, baghdadNow, FOLLOWUP_MANAGER_ROLES } from './rep-followup.service.js';
import { formatRepDigest, countOverdueDoctors, findIdleAreas } from './rep-followup.digest.js';

const MONTH_NAMES_AR = ['', 'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];

/**
 * @param {{actorUser:object, repNameRaw:string|null, month:number|null, year:number, qualifier:string|null, self:boolean}} args
 * @returns {Promise<string|null>} نصّ الجواب، أو null للصمت المقصود.
 */
export async function answerFollowupQuery({ actorUser, repNameRaw, month, year, qualifier, self }) {
  const b = baghdadNow();
  const effMonth = month ?? (b.getUTCMonth() + 1);
  const effYear = month ? year : b.getUTCFullYear();
  const periodKey = periodKeyOf(effYear, effMonth);
  const periodLabel = `${MONTH_NAMES_AR[effMonth]} ${effYear}`;

  const ownerUserId = await resolveDocOwnerUserId(actorUser.id);
  const isManager = FOLLOWUP_MANAGER_ROLES.has(actorUser.role);

  // ── تقييم السائل نفسه ───────────────────────────────────────────────────
  if (self || !isManager) {
    const card = await getSnapshotForViewerRep(actorUser.id, actorUser.id, periodKey);
    if (!card) {
      // المدير الذي يسأل «متابعتي» ليس له لقطة (اللقطات لمندوبيه) — نوجّهه لا نصمت.
      return self && isManager
        ? `لا توجد لقطة باسمك — «متابعة» وحدها تعطي تقييمك الشخصي. لتقرير أحد مندوبيك اكتب اسمه: «متابعة اسم المندوب».`
        : `لا توجد لقطة محسوبة لك في ${periodLabel} بعد. تُحسب تلقائياً كل ليلة 03:00.`;
    }
    return renderCard(card, ownerUserId, periodLabel, { self: true });
  }

  // ── مدير يسأل عن مندوب بالاسم ───────────────────────────────────────────
  if (!repNameRaw) return null;

  const reps = await sciRepSvc.list({}, actorUser, {});
  const candidates = reps
    .map(r => ({ id: r.id, name: r.name, company: r.company ?? null }))
    .filter(r => Number.isInteger(r.id) && r.name);
  if (candidates.length === 0) return null; // لا كتالوج مندوبين مرئي لهذا الحساب

  const index = buildRepIndex(candidates);
  let { status, rep, suggestions } = matchRepName(repNameRaw, index);

  // نفس فكّ الالتباس المستعمل في سؤال المبيعات: اسم الشركة يُضيّق المرشّحين.
  if (status === 'ask' && qualifier) {
    const qNorm = qualifier.replace(/\s+/g, '').toLowerCase();
    const narrowed = suggestions.filter(s => s.company && s.company.replace(/\s+/g, '').toLowerCase().includes(qNorm));
    if (narrowed.length === 1) { rep = narrowed[0]; status = 'exact'; }
  }

  // لا مرشّح يشبه الاسم إطلاقاً ⇒ صمت: الميزة نشطة على كل رسالة نصّية، فردّ خطأ
  // على كل جملة فيها «متابعة» مصادفة كان سيُصبح ضجيجاً.
  if (status === 'none') return null;

  if (status === 'ask' || !rep) {
    const list = suggestions.slice(0, 5).map(s => `• ${s.name}${s.company ? ` (${s.company})` : ''}`).join('\n');
    const example = suggestions[0]?.company ? ` ${suggestions[0].company}` : '';
    return [
      '⚠️ وجدت أكثر من مندوب بهذا الاسم — حدد الشركة/المكتب:',
      list,
      '',
      `أعد كتابة السؤال مع الشركة، مثال: «متابعة ${repNameRaw} شهر ${effMonth}${example}»`,
    ].join('\n');
  }

  // اللقطات مفتاحها repUserId (حساب الدخول)، والمطابقة أعطتنا سجل المندوب
  // العلمي — نربط بينهما بـ scientificRepId المحفوظ في اللقطة.
  const all = await getSnapshotsForViewer(actorUser, periodKey);
  const card = all.find(c => c.scientificRepId === rep.id);
  if (!card) {
    return [
      `لا توجد لقطة محسوبة لـ«${rep.name}» في ${periodLabel}.`,
      all.length
        ? 'هو ليس ضمن فريقك المحسوب لهذه الفترة — تحقّق من الشركة/المدير المُعيَّن له.'
        : 'لم تُحسب أي لقطة لهذه الفترة بعد: افتح صفحة «متابعة المندوبين» واضغط «احسب الآن»، أو انتظر الحساب الليلي 03:00.',
    ].join('\n');
  }

  return renderCard(card, ownerUserId, periodLabel, { self: false });
}

async function renderCard(card, ownerUserId, periodLabel, { self }) {
  const standards = await getStandards(ownerUserId);
  const [overdueDoctors, idleAreas] = await Promise.all([
    countOverdueDoctors(card, standards.doctorRevisitDays),
    findIdleAreas(card, standards.areaIdleDays),
  ]);
  const msg = formatRepDigest(card, standards, { overdueDoctors, idleAreas });

  const head = `📋 متابعة ${card.repName} — ${periodLabel}`;
  if (!msg) {
    // لا بند يستحق تنبيهاً: نعطي المؤشّر على الأقل، فالسؤال صريح هنا (بعكس
    // الملخّص التلقائي الذي يصمت بدل إرسال رسالة فارغة).
    return [head, '', `المؤشّر: ${card.score}/100 — لا ملاحظات تستحق التنبيه في هذه الفترة.`].join('\n');
  }

  const m = card.metrics;
  const extra = [];
  if (m?.sales?.hasData) {
    extra.push(`صافي المبيع: $${Math.round(m.sales.netValue || 0).toLocaleString('en-US')} · الطلبيات: ${m.sales.orderCount}`);
  }
  if (m?.coverage?.totalDoctors) {
    extra.push(`تغطية الأطباء: ${m.coverage.doctorCoveragePct ?? 0}% (${m.coverage.visitedDoctors}/${m.coverage.totalDoctors})`);
  }
  if (card.fileScope && !card.fileScope.synced) {
    extra.push(`⚠️ محسوب على كل ملفات المكتب (${card.fileScope.count} ملف) — فعّل ملفاتك في التطبيق ليطابق الرقم الشاشة.`);
  }

  const lines = [head, '', msg.body];
  if (extra.length) lines.push('', ...extra);
  if (!self) lines.push('', 'للتفصيل الكامل: صفحة «متابعة المندوبين» في التطبيق.');
  return lines.join('\n');
}
