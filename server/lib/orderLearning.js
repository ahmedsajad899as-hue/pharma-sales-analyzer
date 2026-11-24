// ════════════════════════════════════════════════════════════════════════════
// orderLearning.js — «ذاكرة التصحيحات» لطلبيات البوت (طلب صاحب المشروع 2026-11-24).
// ────────────────────────────────────────────────────────────────────────────
// كل خانة يصحّحها المراجِع في «مراجعة طلبيات البوت» تصير درساً يُطبَّق من **أول
// تصحيح** على الطلبيات القادمة، مع شارة 🧠 في البطاقة كي يعرف المراجِع مصدر القيمة.
//
//   الصنف     ← ItemMergeRule عبر rememberItems (الموجود أصلاً؛ صار يشمل الصنف المربوط
//              خطأً لأن ما قرأه المحلّل محفوظ في row._readItem).
//   المنطقة   ← area:      ما قُرئ → المنطقة الصحيحة
//   الصيدلية  ← pharmacy:  ما قُرئ → الاسم الصحيح
//   منطقة الصيدلية ← pharmacyArea: الصيدلية → منطقتها (حين لم تُقرأ منطقة)
//   المذخر    ← warehouse: ما قُرئ → الاسم الصحيح
//   المندوب   ← rep:       منطقة|صنف → المندوب المختار
//
// الدرس يُكتب فوق نفسه: تصحيح ثانٍ لنفس المفتاح يستبدله، وإرجاع القيمة لما قُرئ
// يحذفه. النطاق = المكتب العلمي (o:<id>)، وإلا الحساب (u:<id>).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeAreaName, normalizeArabic } from './itemResolver.js';
import { pharmacyKey } from './pharmacyKey.js';

export const LEARN_FIELDS = ['area', 'pharmacy', 'pharmacyArea', 'warehouse', 'rep'];

const clip = (s, n = 200) => String(s ?? '').trim().slice(0, n);

/** مفتاح المطابقة لكل خانة — نفس التطبيع الذي تستعمله بقية المطابقات. */
export function learnKey(field, value) {
  if (field === 'area') return normalizeAreaName(value ?? '');
  // المذخر: «مذخر الصيدلي» ≡ «الصيدلي». لا pharmacyKey: يحذف «صيدلي» كلمةً عامة فيفرغ المفتاح.
  if (field === 'warehouse') return normalizeArabic(value ?? '').toLowerCase().replace(/^(مذخر|م\.?)\s+/, '').trim();
  return pharmacyKey(value ?? '');
}

/** مفتاح درس المندوب: المنطقة + الصنف المربوط (صاحب الصنف في المنطقة). */
export function repLearnKey(area, itemId) {
  const id = Number(itemId);
  return Number.isFinite(id) && id > 0 ? `${normalizeAreaName(area ?? '')}|${id}` : '';
}

export async function learningScopeOf(userId) {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { officeId: true } });
  return u?.officeId ? `o:${u.officeId}` : `u:${userId}`;
}

async function loadLessons(scope, fields) {
  if (!scope) return new Map();
  const rows = await prisma.orderLearning.findMany({
    where: { scope, field: { in: fields } },
    select: { id: true, field: true, fromKey: true, toName: true, toId: true },
  });
  return new Map(rows.map(r => [`${r.field}\u0000${r.fromKey}`, r]));
}

function touch(ids) {
  if (!ids.size) return;
  prisma.orderLearning.updateMany({ where: { id: { in: [...ids] } }, data: { hits: { increment: 1 }, lastUsedAt: new Date() } })
    .catch(() => {});
}

/**
 * يطبّق دروس المنطقة/الصيدلية/المذخر على صفوف طلبية (في الذاكرة). يُستدعى قبل تخمين
 * المندوب كي يُخمَّن من المنطقة المصحّحة. ما قرأه المحلّل يبقى في row._learned
 * (الواجهة تقارن به عند الحفظ، فتصحيح القيمة المتعلَّمة يستبدل الدرس لا يُضاعفه).
 */
export async function applyFieldLessons(rows, scope) {
  const list = (rows || []).filter(Boolean);
  if (!list.length || !scope) return rows;
  let lessons;
  try { lessons = await loadLessons(scope, ['area', 'pharmacy', 'pharmacyArea', 'warehouse']); }
  catch (e) { console.error('[orderLearning] load:', e?.message); return rows; }
  if (!lessons.size) return rows;
  const used = new Set();
  const get = (field, value) => {
    const k = learnKey(field, value);
    return k ? lessons.get(`${field}\u0000${k}`) : null;
  };
  for (const r of list) {
    const learned = r._learned && typeof r._learned === 'object' ? r._learned : {};
    for (const field of ['pharmacy', 'area', 'warehouse']) {
      const cur = String(r[field] ?? '').trim();
      if (!cur || learned[field] != null) continue;
      const l = get(field, cur);
      if (!l || learnKey(field, l.toName) === learnKey(field, cur)) continue;
      learned[field] = cur;
      r[field] = l.toName;
      used.add(l.id);
    }
    // منطقة لم تُقرأ ← منطقة هذه الصيدلية كما صحّحها المراجِع سابقاً
    if (!String(r.area ?? '').trim() && String(r.pharmacy ?? '').trim()) {
      const l = get('pharmacyArea', r.pharmacy);
      if (l) { learned.area = ''; r.area = l.toName; used.add(l.id); }
    }
    if (Object.keys(learned).length) r._learned = learned;
  }
  touch(used);
  return rows;
}

/** درس المندوب (منطقة|صنف) يغلب التخمين — يُستدعى بعد كل خطوات المندوب. */
export async function applyRepLessons(rows, scope) {
  const list = (rows || []).filter(r => r && r._itemId);
  if (!list.length || !scope) return rows;
  let lessons;
  try { lessons = await loadLessons(scope, ['rep']); }
  catch (e) { console.error('[orderLearning] load rep:', e?.message); return rows; }
  if (!lessons.size) return rows;
  const used = new Set();
  for (const r of list) {
    const l = lessons.get(`rep\u0000${repLearnKey(r.area, r._itemId)}`);
    if (!l) continue;
    const learned = r._learned && typeof r._learned === 'object' ? r._learned : {};
    if (learned.rep == null) learned.rep = String(r.scientificRep ?? '');
    r._learned = learned;
    r.scientificRep = l.toName;
    r._repPick = 'memory';
    used.add(l.id);
  }
  touch(used);
  return rows;
}

/**
 * يحفظ تصحيحات المراجِع بعد حفظ ناجح.
 * corrections: [{ field, from, to, toId?, area?, itemId?, itemName? }]
 */
export async function recordLessons(user, corrections) {
  const scope = await learningScopeOf(user?.id);
  if (!scope || !Array.isArray(corrections)) return { saved: 0, removed: 0 };
  const byName = clip(user.displayName || user.username, 80) || null;
  let saved = 0, removed = 0;
  for (const c of corrections.slice(0, 80)) {
    const field = String(c?.field ?? '');
    if (!LEARN_FIELDS.includes(field)) continue;
    const to = clip(c.to);
    let fromKey, fromName;
    if (field === 'rep') {
      fromKey = repLearnKey(c.area, c.itemId);
      fromName = clip(`${c.area || '—'} · ${c.itemName || c.itemId}`);
    } else {
      fromName = clip(c.from);
      fromKey = learnKey(field === 'pharmacyArea' ? 'pharmacy' : field, fromName);
    }
    if (!fromKey) continue;
    const where = { scope_field_fromKey: { scope, field, fromKey } };
    // إرجاع القيمة لما قرأه المحلّل (أو مسحها) = إلغاء الدرس
    const sameAsRead = field !== 'rep' && field !== 'pharmacyArea' && learnKey(field, to) === fromKey;
    if (!to || sameAsRead) {
      const r = await prisma.orderLearning.deleteMany({ where: { scope, field, fromKey } }).catch(() => ({ count: 0 }));
      removed += r.count || 0;
      continue;
    }
    const toId = Number.isFinite(Number(c.toId)) && Number(c.toId) > 0 ? Number(c.toId) : null;
    await prisma.orderLearning.upsert({
      where,
      update: { fromName, toName: to, toId, createdById: user.id, createdByName: byName },
      create: { scope, field, fromKey, fromName, toName: to, toId, createdById: user.id, createdByName: byName },
    }).then(() => { saved++; }).catch(e => console.error('[orderLearning] save:', e?.message));
  }
  return { saved, removed };
}

/** رسالة غيّر فيها المراجِع الأسطر/الكميات — مادة لإصلاح المحلّل. */
export async function recordCorrectionCase(user, c) {
  if (!c || !Array.isArray(c.reasons) || !c.reasons.length) return null;
  const scope = await learningScopeOf(user?.id);
  const json = (v) => JSON.parse(JSON.stringify(v ?? null, (_k, x) => (typeof x === 'string' ? x.slice(0, 300) : x)));
  return prisma.orderCorrectionCase.create({
    data: {
      scope: scope || '',
      pendingId: Number.isFinite(Number(c.pendingId)) ? Number(c.pendingId) : null,
      source: clip(c.source, 30) || null,
      chatTitle: clip(c.chatTitle, 150) || null,
      senderName: clip(c.senderName, 100) || null,
      sourceText: String(c.sourceText ?? '').slice(0, 4000) || null,
      reasons: c.reasons.map(x => clip(x, 60)).filter(Boolean).slice(0, 12).join(' · '),
      parsed: json(c.parsed),
      saved: json(c.saved),
      createdById: user.id,
      createdByName: clip(user.displayName || user.username, 80) || null,
    },
    select: { id: true },
  }).catch(e => { console.error('[orderLearning] case:', e?.message); return null; });
}
