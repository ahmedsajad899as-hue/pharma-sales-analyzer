// ════════════════════════════════════════════════════════════════════════════
// itemTiers.js — فئات ايتمات المسوقين: رئيسية / ثانوية
// ────────────────────────────────────────────────────────────────────────────
// تُحدَّد عند مدير المسوقين (أو التيم ليدر) فيرثها كل من تحته عبر
// UserManagerAssignment، ويمكن تغيير ايتم لمندوب بعينه من حسابه هو. يُخزَّن في
// UserItemTier ما يخالف الموروث فقط؛ غياب الصف = يرث، والجذر = رئيسي.
//
// User.secondaryItemsMode — كيف تُحسب الثانوية في تقارير المسوّق (يُورَّث كذلك):
//   count    تُحسب ضمن المجموع (الافتراضي)
//   separate تظهر في المقارنة ولا تدخل المجموع
//   hide     تُستبعد تماماً
//
// الفئة تُطابَق باسم الايتم المطبَّع (normalizeItemKey): نفس الدواء صفوف Item
// متعددة (كتالوج، مؤقتة لكل ملف، لكل حساب) — كالتوسيع في itemScope.js.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeItemKey } from './itemResolver.js';

export const TIER_MAIN = 'main';
export const TIER_SECONDARY = 'secondary';
export const SECONDARY_MODES = ['count', 'separate', 'hide'];
export const DEFAULT_SECONDARY_MODE = 'count';

const MAX_DEPTH = 4; // مندوب ← تيم ليدر ← مدير المسوقين، وهامش

/** مستويات السلسلة: [[المستخدم], [مدراؤه], [مدراء مدرائه], …] بلا تكرار. */
async function managerLevels(userId) {
  const levels = [[userId]];
  const seen = new Set([userId]);
  for (let d = 0; d < MAX_DEPTH; d++) {
    const rows = await prisma.userManagerAssignment.findMany({
      where: { userId: { in: levels[levels.length - 1] } }, select: { managerId: true },
    });
    const next = [...new Set(rows.map(r => r.managerId))].filter(id => !seen.has(id));
    if (!next.length) break;
    for (const id of next) seen.add(id);
    levels.push(next);
  }
  return levels;
}

/**
 * فئات ايتمات مستخدم بعد الوراثة.
 * @returns {Promise<{
 *   mode: string, modeFromUserId: number|null,
 *   inheritedMode: string|null, inheritedModeFromUserId: number|null,
 *   byKey: Map<string, {tier: string, fromUserId: number}>,
 *   inheritedByKey: Map<string, {tier: string, fromUserId: number}>,
 *   own: {itemId: number, tier: string}[],
 *   users: Map<number, string>,
 *   hasSecondary: boolean,
 *   tierOf: (itemName: string) => string,
 * }>}
 */
export async function resolveUserItemTiers(userId) {
  const levels = await managerLevels(userId);
  const allIds = levels.flat();
  const [tierRows, userRows] = await Promise.all([
    prisma.userItemTier.findMany({
      where: { userId: { in: allIds } },
      select: { userId: true, itemId: true, tier: true, item: { select: { name: true } } },
    }),
    prisma.user.findMany({
      where: { id: { in: allIds } },
      select: { id: true, displayName: true, username: true, secondaryItemsMode: true },
    }),
  ]);
  const userById = new Map(userRows.map(u => [u.id, u]));
  const rowsByUser = new Map();
  for (const r of tierRows) {
    if (!rowsByUser.has(r.userId)) rowsByUser.set(r.userId, []);
    rowsByUser.get(r.userId).push(r);
  }

  // من الأبعد إلى الأقرب: الأقرب يكتب فوق الأبعد، والمستخدم نفسه أخيراً.
  const byKey = new Map();
  const inheritedByKey = new Map();
  for (let li = levels.length - 1; li >= 0; li--) {
    for (const uid of levels[li]) {
      for (const r of rowsByUser.get(uid) ?? []) {
        const key = normalizeItemKey(r.item?.name || '');
        if (!key) continue;
        const v = { tier: r.tier === TIER_SECONDARY ? TIER_SECONDARY : TIER_MAIN, fromUserId: uid };
        byKey.set(key, v);
        if (li > 0) inheritedByKey.set(key, v);
      }
    }
  }

  const modeAt = (fromLevel) => {
    for (let li = fromLevel; li < levels.length; li++) {
      for (const uid of levels[li]) {
        const m = userById.get(uid)?.secondaryItemsMode;
        if (SECONDARY_MODES.includes(m)) return { mode: m, from: uid };
      }
    }
    return { mode: null, from: null };
  };
  const eff = modeAt(0), inh = modeAt(1);

  return {
    mode: eff.mode ?? DEFAULT_SECONDARY_MODE,
    modeFromUserId: eff.from,
    inheritedMode: inh.mode,
    inheritedModeFromUserId: inh.from,
    byKey,
    inheritedByKey,
    own: (rowsByUser.get(userId) ?? []).map(r => ({ itemId: r.itemId, tier: r.tier })),
    users: new Map(userRows.map(u => [u.id, u.displayName || u.username])),
    hasSecondary: [...byKey.values()].some(v => v.tier === TIER_SECONDARY),
    tierOf: (itemName) => byKey.get(normalizeItemKey(itemName || ''))?.tier ?? TIER_MAIN,
  };
}

/**
 * يوسم صفوف تقرير مسوّق بفئة الايتم (itemTier) ويطبّق وضع الثانوية:
 * hide ← تُحذف، separate ← tierUncounted=true (تظهر بالمقارنة لا بالمجموع).
 * بلا أي ايتم ثانوي في السلسلة ← الصفوف كما هي ولا وسم (لا أثر إطلاقاً).
 * تحتاج s.item.name في الـselect (كل selects التقارير تجلبه).
 */
export async function applyItemTiersToRows(userId, rows) {
  if (!userId) return { rows, mode: null };
  // تحسين لا شرط: أي فشل (جدول لم يُرحَّل بعد مثلاً) لا يُسقط تقرير المسوّق — يبقى بلا فئات.
  let t;
  try {
    t = await resolveUserItemTiers(userId);
  } catch (e) {
    console.warn('[itemTiers] skipped for user', userId, '-', e.message);
    return { rows, mode: null };
  }
  if (!t.hasSecondary) return { rows, mode: null };
  const out = [];
  for (const s of rows) {
    const itemTier = t.tierOf(s.item?.name);
    if (itemTier === TIER_SECONDARY && t.mode === 'hide') continue;
    out.push(itemTier === TIER_SECONDARY && t.mode === 'separate'
      ? { ...s, itemTier, tierUncounted: true }
      : { ...s, itemTier });
  }
  return { rows: out, mode: t.mode };
}
