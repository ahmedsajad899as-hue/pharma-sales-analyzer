// ════════════════════════════════════════════════════════════════════════════
// sales-query.js — يجيب على سؤال مبيعات مكتوب بالكروب («محمد باقر مبيع شهر 9»):
// يطابق الاسم بمندوبي حساب الكروب المرتبط (نفس محرّك مطابقة أسماء ميركاتو)،
// يجمع ملفات هذا الحساب/مكتبه، ثم يستدعي scientific-reps.getReport() — نفس
// دالة تقرير المندوب العلمي المستعملة بالواجهة (فصل مكتب/ميركاتو، دمج ومطابقة
// الأسماء، كل الحجوبات) — فلا يوجد منطق مبيعات مكرَّر هنا.
//
// صمت عمدي حين لا يوجد مرشّح يشبه الاسم إطلاقاً (status='none'): الميزة نشطة
// على كل رسالة نصّية في كل كروب (لا كلمة مفتاحية صارمة كالطلبيات)، فردّ خطأ على
// كل جملة فيها «مبيع» و«شهر» مصادفة كان سيُصبح ضجيجاً. لا صمت عند التباس
// (status='ask') — هذا سؤال واضح يستحق رداً، حتى لو كان توضيحياً.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import * as sciRepSvc from '../scientific-reps/scientific-reps.service.js';
import { buildRepIndex, matchRepName } from '../../lib/repNameMatch.js';
import { resolveActiveFileIds } from '../../lib/activeFiles.js';

const MONTH_NAMES_AR = ['', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function monthRange(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  // اليوم الأخير من الشهر = يوم 0 من الشهر التالي، بآخر لحظة فيه.
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start, end };
}

const fmtUSD = (v) => `$${Math.round(v || 0).toLocaleString('en-US')}`;

// الملفات التي يحسب عليها البوت = «الملفات المفعّلة» لهذا الحساب كما يراها
// التطبيق. المنطق مشترك في lib/activeFiles.js لأن كل حاسب بلا واجهة (البوت،
// ملخّص متابعة المندوبين، اللقطة الليلية) يجب أن يحسب على نفس الملفات.
const resolveBotFileIds = resolveActiveFileIds;

function formatReport(repName, month, year, report) {
  const lines = [`📊 مبيعات ${repName} — ${MONTH_NAMES_AR[month]} ${year}`, ''];
  lines.push(`الصافي: ${fmtUSD(report.summary.totalValue)} — عدد الطلبيات: ${report.summary.orderCount}`);
  if (report.bySource?.hasOffice || report.bySource?.hasMercato) {
    if (report.bySource.hasOffice) lines.push(`• المكتب: ${fmtUSD(report.bySource.office.totalValue)} (${report.bySource.office.orderCount} طلبية)`);
    if (report.bySource.hasMercato) lines.push(`• ميركاتو: ${fmtUSD(report.bySource.mercato.totalValue)} (${report.bySource.mercato.orderCount} طلبية)`);
  }
  if (!report.summary.totalValue && !report.summary.orderCount) {
    lines.push('', 'لا توجد مبيعات مسجَّلة لهذا الشهر.');
  }
  return lines.join('\n');
}

/**
 * @param {{actorUser:object, repNameRaw:string, month:number, year:number, qualifier:string|null, detailed:boolean}} params
 * @returns {Promise<string|null>} نص الرد، أو null إذا لزم الصمت (لا مرشّح يشبه الاسم إطلاقاً)
 */
export async function answerSalesQuery({ actorUser, repNameRaw, month, year, qualifier, detailed = false }) {
  const reps = await sciRepSvc.list({}, actorUser, {});
  const candidates = reps
    .map((r) => ({ id: r.id, name: r.name, company: r.company ?? null }))
    .filter((r) => Number.isInteger(r.id) && r.name);
  if (candidates.length === 0) return null; // لا كتالوج مندوبين مرئي لهذا الحساب

  const index = buildRepIndex(candidates);
  let { status, rep, suggestions } = matchRepName(repNameRaw, index);

  // اسم الشركة/المكتب المُلحَق بالرسالة يفكّ الالتباس حين يتعدّد المرشّحون.
  if (status === 'ask' && qualifier) {
    const qNorm = qualifier.replace(/\s+/g, '').toLowerCase();
    const narrowed = suggestions.filter((s) => s.company && s.company.replace(/\s+/g, '').toLowerCase().includes(qNorm));
    if (narrowed.length === 1) { rep = narrowed[0]; status = 'exact'; }
  }

  if (status === 'none') return null;

  if (status === 'ask' || !rep) {
    const list = suggestions.slice(0, 5).map((s) => `• ${s.name}${s.company ? ` (${s.company})` : ''}`).join('\n');
    const example = suggestions[0]?.company ? ` ${suggestions[0].company}` : '';
    return [
      '⚠️ وجدت أكثر من مندوب بهذا الاسم — حدد الشركة/المكتب:',
      list,
      '',
      `أعد كتابة السؤال مع إضافة الشركة، مثال: "${repNameRaw}${example} مبيع شهر ${month}"`,
    ].join('\n');
  }

  const files = await resolveBotFileIds(actorUser.id);
  if (files.ids.length === 0) return `لا توجد ملفات مبيعات مفعّلة لهذا الحساب.`;

  const { start, end } = monthRange(year, month);
  const report = await sciRepSvc.getReport(
    rep.id,
    { fileIds: files.ids, startDate: start.toISOString(), endDate: end.toISOString() },
    actorUser.id,
  );

  let answer = formatReport(rep.name, month, year, report);

  // بلا مزامنة، الحساب يجري على كل ملفات المكتب — وهي غالباً متداخلة (نفس
  // الطلبية في ملف شهري وآخر مجمَّع)، فيخرج رقم أعلى مما تعرضه الشاشة. منع
  // التكرار لا ينقذ هنا: لا يُسقط إلا الصفوف المتطابقة حرفياً. نقولها صراحةً
  // بدل تسليم رقم منتفخ بصمت.
  if (!files.synced) {
    answer += `\n\n⚠️ محسوب على كل ملفات المكتب (${files.ids.length} ملف) وقد يتضمّن تكراراً بين ملفات متداخلة.`
      + `\nافتح التطبيق بهذا الحساب مرة واحدة لتُزامَن «الملفات المفعّلة» فيطابق الرقم شاشة التحليل.`;
  }

  if (!detailed) return answer;

  // وضع «تفاصيل»: يكشف المدخلات التي تصنع أي فرق عن شاشة التطبيق — مجموعة
  // الملفات، وحساب المُشاهِد (مفاتيح الحجب واستبعاد المذاخر شخصية لكل حساب).
  const excludeWarehouse = await sciRepSvc.getExcludeWarehouseSales(actorUser.id);
  const shown = files.names.slice(0, 10).map((n) => `   • ${n}`).join('\n');
  return [
    answer,
    '',
    '— تفاصيل الحساب —',
    `الحساب: ${actorUser.displayName || actorUser.username} (#${actorUser.id})`,
    `استبعاد مبيعات المذاخر: ${excludeWarehouse ? 'نعم' : 'لا'}`,
    `مصدر الملفات: ${files.source}`,
    `الملفات (${files.ids.length}):`,
    shown + (files.names.length > 10 ? `\n   • … و${files.names.length - 10} غيرها` : ''),
    `صفوف مطابقة: ${report._debug?.rawRowCount ?? '—'}`,
  ].join('\n');
}
