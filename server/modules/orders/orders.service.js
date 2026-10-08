// ════════════════════════════════════════════════════════════════════════════
// orders.service.js — طابور الطلبيات الواردة من البوتات (PendingBotOrder).
//
// الطلبية تُستخرَج بالذكاء ثم **تنتظر** هنا. لا شيء يصل جدول Sale إلا بعد أن يفتح
// المستخدم شبكة المراجعة في التطبيق ويؤكّد — فالحفظ النهائي يمرّ حصراً بمسار
// insertManualSales القائم (POST /api/sales/manual) ومن هناك يُحذَف الصف المعلَّق.
// نفس عقد PendingVisitsImport، إلا في شيء واحد: هنا عدة صفوف لكل مستخدم مسموحة.
// ════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { buildRepIndex, matchRepName, repCoreName } from '../../lib/repNameMatch.js';
import { getAssignedItemsCatalog } from '../../lib/itemScope.js';
import { loadResolutionContext, resolveItemName, normalizeAreaName } from '../../lib/itemResolver.js';

const __dirname3 = path.dirname(fileURLToPath(import.meta.url));

// صور الطلبيات. **ليس** داخل server/uploads: ذاك المجلد يُخدَم ساكناً من
// server/index.js فوق بوابة JWT، فأي ملف فيه مقروء للعالم بمعرفة اسمه. هذا المجلد
// (جذر المشروع/uploads) خاص — نفس مكان ملفات الإكسل المحفوظة — ويُقرأ حصراً عبر
// نقطة مصادَقة تفحص ملكية الصف أولاً. وهو أيضاً خارج أرشيف النشر (deploy.ps1
// يحزم server/ وprisma/ فقط) فلا تُنشَر صور التطوير للإنتاج.
const BOT_ORDER_IMAGES_DIR = path.join(__dirname3, '..', '..', '..', 'uploads', 'bot-orders');

/** حدّ الطلبيات المعلَّقة لكل مستخدم — حارس تكلفة وقاعدة بيانات، لا قيد منطقي. */
export const MAX_PENDING_ORDERS_PER_USER = 30;

/** تُقلَّم الصفوف الأقدم من هذا تلقائياً عند أول قراءة للقائمة. */
const PRUNE_AFTER_DAYS = 30;

const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * بصمة الطلبية — الحارس الفعلي ضد التكرار، مستقلّ عن حارس update_id في تلكرام
 * (لا يصمد أمام الألبومات) وعن message_token في فايبر (ليس عدّاداً تصاعدياً).
 * النص يُطبَّع بإسقاط المسافات وحالة الأحرف فإعادة لصق نفس الطلبية تُكتشف.
 */
export function orderSourceHash({ userId, text, mediaKeys = [] }) {
  const normText = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const keys = [...mediaKeys].map(String).sort().join(',');
  return crypto.createHash('sha256').update(`${userId}|${normText}|${keys}`).digest('hex');
}

// ─── مطابقة الايتمات وتعبئة الشركة والسعر ───────────────────────────────────

/**
 * نطاق مطابقة الايتمات: الايتمات المعيَّنة للمستخدم إن وُجدت (وهي ما يعنيه
 * المستخدم بـ«ايتمات المندوب»)، وإلا كتالوج شركاته العلمية — نفس اصطلاح
 * checkManualNames وresolveEffectiveItemIds: تعيين فارغ لا يعني صفر ايتمات.
 */
async function buildItemContext(userId) {
  if (!userId) return null;
  const assigned = await getAssignedItemsCatalog(userId);
  if (assigned && assigned.length > 0) {
    return {
      catalog: assigned,
      catalogById: new Map(assigned.map(c => [c.id, c])),
      aliasMap: new Map(),
      scope: 'assigned',
    };
  }
  const ua = await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
  const ids = ua.map(c => c.companyId).filter(Boolean);
  const ctx = await loadResolutionContext({ scientificCompanyIds: ids, userId });
  return { ...ctx, scope: ids.length > 0 ? 'catalog' : 'user-items' };
}

/**
 * يطابق اسم كل صنف بكتالوج المستخدم، ويملأ الشركة وسعر الوحدة من بطاقة الايتم.
 *
 * يُطبَّق على **الصفوف غير المحفوظة** قبل دخولها الطابور، فكل ما يكتبه هنا يبقى
 * قابلاً لتعديل المراجِع في الشبكة — لا حفظ ولا إنشاء ايتم جديد في أي حال.
 *
 * الربط التلقائي يقتصر على ثقة alias/exact/high (نفس سلّم itemResolver): المتشابه
 * الملتبس (medium) يُترك كما كُتب وتُرفَق مرشّحاته في `_itemMatch` ليسأل عنه مسار
 * check-names عند الحفظ — لا نحسم اللبس صامتين فنُسند مبيعات لايتم خاطئ.
 *
 * السعر: «سعر المذخر» (Item.warehousePrice) أولاً ثم «سعر المكتب» (Item.price)
 * بديلاً. ولا يُكتب فوق سعر ذكره المرسِل في نصّ الطلبية.
 */
export async function enrichRowsFromCatalog(rows, userId) {
  if (!Array.isArray(rows) || rows.length === 0 || !userId) return rows;

  let ctx = null;
  try {
    ctx = await buildItemContext(userId);
  } catch (e) {
    console.error('[orders] تعذّر تحميل كتالوج الايتمات:', e?.message);
    return rows; // المطابقة تحسين لا شرط — فشلها لا يُسقط الطلبية
  }
  if (!ctx || !ctx.catalog?.length) return rows;

  const names = [...new Set(rows.map(r => String(r.item ?? '').trim()).filter(Boolean))];
  const resolved = new Map();
  for (const name of names) {
    try { resolved.set(name, await resolveItemName(name, ctx)); } catch { /* يبقى كما كُتب */ }
  }

  const ids = [...new Set([...resolved.values()].map(r => r?.canonicalItem?.id).filter(Boolean))];
  const details = ids.length
    ? await prisma.item.findMany({
        where:  { id: { in: ids } },
        select: {
          id: true, name: true, price: true, warehousePrice: true,
          scientificCompanyId: true,
          company:           { select: { name: true } },
          scientificCompany: { select: { name: true } },
        },
      })
    : [];
  const byId = new Map(details.map(d => [d.id, d]));

  for (const row of rows) {
    const key = String(row.item ?? '').trim();
    const r = resolved.get(key);
    if (!r) continue;

    row._itemMatch = { confidence: r.confidence, suggestions: (r.suggestions || []).slice(0, 5) };
    const autoLink = r.confidence === 'alias' || r.confidence === 'exact' || r.confidence === 'high';
    if (!autoLink || !r.canonicalItem) continue;

    row.item    = r.canonicalItem.name; // توحيد الاسم مع الكتالوج
    row._itemId = r.canonicalItem.id;

    const d = byId.get(r.canonicalItem.id);
    if (!d) continue;
    // **الشركة العلمية أولاً** — وهي ما تعرضه صفحة «الايتمات» بالماستر أدمن
    // (تُجمَّع الايتمات تحت ScientificCompany)، وهي أيضاً ما تشير إليه
    // UserCompanyAssignment.companyId. حقل Company منفصل وقد يختلف للايتم نفسه
    // («Moreserc 16 mg»: Company = HEJHEZ بينما ScientificCompany = HELPA) —
    // فتفضيله كان يعرض اسماً لا يراه المستخدم في أي مكان آخر بالتطبيق.
    row.company = d.scientificCompany?.name || d.company?.name || row.company || null;
    row._scientificCompanyId = d.scientificCompanyId ?? null;

    // سعر المذخر أولاً (طلب صريح من صاحب المشروع) ثم سعر المكتب بديلاً — ملء
    // الخانة بسعر المكتب أفضل من تركها فارغة، وسعر المذخر مملوء في ايتم واحد
    // فقط من 153 حتى الآن. المراجِع يصحّح أي سعر قبل الحفظ على أي حال.
    const catalogPrice = d.warehousePrice ?? d.price ?? null;
    if (row.unitPrice == null && catalogPrice != null) row.unitPrice = catalogPrice;
    if (row.total == null && row.quantity != null && row.unitPrice != null) {
      row.total = Number(row.quantity) * Number(row.unitPrice);
    }
  }
  return rows;
}

// ─── تخمين المندوب العلمي صاحب الطلبية ──────────────────────────────────────

/**
 * يخمّن المندوب العلمي الذي تخصّه الطلبية من ثلاثة أدلة متقاطعة:
 * الشركة العلمية للصنف + منطقة الصيدلية + تعيين الصنف نفسه للمندوب.
 *
 * التخمين **لا يُحسم إلا حين يبقى مرشّح واحد**؛ وجود أكثر من مرشّح يترك الحقل
 * فارغاً مع قائمة المرشّحين في `_repCandidates` ليختار المراجِع — إسناد طلبية
 * لمندوب خاطئ أسوأ من خانة فارغة، وهو خطأ لا يظهر إلا بعد شهور في التقارير.
 *
 * النطاق: مندوبو **نفس المكتب العلمي** للحساب المربوط بالكروب فقط.
 */
export async function attachScientificRepGuess(rows, actingUser) {
  if (!Array.isArray(rows) || rows.length === 0 || !actingUser) return rows;

  const itemIds = [...new Set(rows.map(r => r._itemId).filter(Boolean))];
  const areaNames = [...new Set(rows.map(r => r.area).filter(Boolean).map(normalizeAreaName).filter(Boolean))];
  if (itemIds.length === 0 && areaNames.length === 0) return rows;

  try {
    const [reps, areas] = await Promise.all([
      prisma.user.findMany({
        where: {
          role: 'scientific_rep',
          isActive: true,
          ...(actingUser.officeId ? { officeId: actingUser.officeId } : {}),
        },
        select: {
          id: true, username: true, displayName: true,
          areaAssignments:    { select: { areaId: true } },
          companyAssignments: { select: { companyId: true } },
          itemAssignments:    { select: { itemId: true } },
        },
      }),
      areaNames.length
        ? prisma.area.findMany({ select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    if (!reps.length) return rows;

    // اسم المنطقة قد يتكرّر كصفوف Area متعدّدة (المنطقة لكل حساب لا عالمية —
    // راجع ذاكرة project_pharma_area_account_scoping)، فنجمع كل المعرّفات.
    const areaIdsByName = new Map();
    for (const a of areas) {
      const k = normalizeAreaName(a.name);
      if (!k) continue;
      if (!areaIdsByName.has(k)) areaIdsByName.set(k, new Set());
      areaIdsByName.get(k).add(a.id);
    }

    const index = reps.map(r => ({
      id: r.id,
      name: r.displayName?.trim() || r.username,
      areas:     new Set(r.areaAssignments.map(a => a.areaId)),
      companies: new Set(r.companyAssignments.map(c => c.companyId)),
      items:     new Set(r.itemAssignments.map(i => i.itemId)),
    }));

    for (const row of rows) {
      const sciId = row._scientificCompanyId ?? null;
      const areaKey = row.area ? normalizeAreaName(row.area) : '';
      const areaIds = areaKey ? (areaIdsByName.get(areaKey) ?? new Set()) : new Set();

      let candidates = index;
      // المنطقة أقوى دليل — تُطبَّق أولاً حين نعرفها فعلاً.
      if (areaIds.size > 0) {
        candidates = candidates.filter(c => [...areaIds].some(id => c.areas.has(id)));
      }
      if (sciId != null) {
        const byCompany = candidates.filter(c => c.companies.has(sciId));
        if (byCompany.length > 0) candidates = byCompany;
      }
      if (row._itemId) {
        const byItem = candidates.filter(c => c.items.size === 0 || c.items.has(row._itemId));
        if (byItem.length > 0) candidates = byItem;
      }

      row._repCandidates = candidates.slice(0, 6).map(c => ({ id: c.id, name: c.name }));
      row.scientificRep = candidates.length === 1 ? candidates[0].name : null;
    }
  } catch (e) {
    console.error('[orders] تعذّر تخمين المندوب العلمي:', e?.message);
  }
  return rows;
}

/** عدد صفوف الطلبية المعلَّقة — يُعرَض في الشريط وفي ردّ البوت. */
export async function countPendingOrders(userId) {
  return prisma.pendingBotOrder.count({ where: { userId } });
}

/**
 * يحلّ مندوب الطلبية من حساب الكروب المربوط (قرار المستخدم: الاسم من الحساب لا
 * من نص الرسالة). repCoreName يُسقط لاحقة «/ المنطقة ph» التي تحملها أسماء
 * الحسابات الفعلية، ثم تُطابَق النتيجة بمندوبي ذلك الحساب. عند اللبس يبقى repId
 * فارغاً ويختار المراجِع من المنسدلة — لا نُنشئ مندوباً تلقائياً هنا أبداً.
 */
async function resolveRep(user) {
  const core = repCoreName(user.displayName?.trim() || user.username || '');
  if (!core) return { repName: null, repId: null };
  try {
    const reps = await prisma.medicalRepresentative.findMany({
      where: { userId: user.id }, select: { id: true, name: true },
    });
    if (reps.length) {
      const m = matchRepName(core, buildRepIndex(reps));
      if (m.status === 'exact' && m.rep) return { repName: m.rep.name, repId: m.rep.id };
    }
  } catch (e) {
    console.error('[orders] تعذّر مطابقة المندوب:', e?.message);
  }
  return { repName: core, repId: null };
}

async function saveImages(buffers) {
  if (!buffers?.length) return [];
  await fs.mkdir(BOT_ORDER_IMAGES_DIR, { recursive: true });
  const names = [];
  for (const buf of buffers) {
    if (!buf?.length) continue;
    const name = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.jpg`;
    await fs.writeFile(path.join(BOT_ORDER_IMAGES_DIR, name), buf);
    names.push(name);
  }
  return names;
}

/** حذف صور صفٍّ — best-effort، فشلها لا يُسقط حذف الصف نفسه. */
async function unlinkImages(imageFiles) {
  for (const name of toImageList(imageFiles)) {
    await fs.unlink(path.join(BOT_ORDER_IMAGES_DIR, name)).catch(() => {});
  }
}

/** يُعيد أسماء ملفات آمنة فقط — حارس ضد اجتياز المسار من قيمة Json مشوّهة. */
function toImageList(imageFiles) {
  if (!Array.isArray(imageFiles)) return [];
  return imageFiles.filter(n =>
    typeof n === 'string' && n === path.basename(n) && ALLOWED_IMAGE_EXT.has(path.extname(n).toLowerCase()),
  );
}

/**
 * يُسجّل طلبية مستخرَجة في الطابور ويُعيد نصّ ردّ البوت بالعربية.
 * يرمي AppError تشغيلياً (isOperational) فيصل نصّه للكروب كما هو.
 */
export async function ingestBotOrder({
  user, source, chatId, chatTitle = null, senderName = null,
  kind, sourceText = null, rows, imageBuffers = [], mediaKeys = [],
}) {
  if (!rows?.length) throw new AppError('لم أتعرّف على أي صنف في هذه الطلبية.', 422, 'NO_ORDER_ROWS');

  const pending = await countPendingOrders(user.id);
  if (pending >= MAX_PENDING_ORDERS_PER_USER) {
    throw new AppError(
      `لديك ${pending} طلبية بانتظار المراجعة — راجِعها أو ألغِ بعضها من التطبيق أولاً.`,
      409, 'PENDING_ORDERS_FULL',
    );
  }

  const { repName, repId } = await resolveRep(user);
  const sourceHash = orderSourceHash({ userId: user.id, text: sourceText, mediaKeys });

  // الصور تُكتب قبل الصف كي لا يُنشأ صف يشير لملفات غير موجودة؛ وإن فشل الصف
  // (تكرار مثلاً) تُحذَف الملفات في catch أدناه.
  const imageFiles = await saveImages(imageBuffers);

  let created;
  try {
    created = await prisma.pendingBotOrder.create({
      data: {
        userId: user.id, source, chatId: String(chatId), chatTitle, senderName,
        repName, repId, kind,
        sourceText: sourceText || null,
        imageFiles: imageFiles.length ? imageFiles : null,
        payload: { rows, extractedAt: new Date().toISOString() },
        rowCount: rows.length,
        sourceHash,
      },
      select: { id: true },
    });
  } catch (err) {
    await unlinkImages(imageFiles);
    if (err?.code === 'P2002') {
      throw new AppError('هذه الطلبية مُسجَّلة مسبقاً بانتظار المراجعة.', 409, 'DUPLICATE_ORDER');
    }
    throw err;
  }

  const pharmacies = [...new Set(rows.map(r => r.pharmacy).filter(Boolean))];
  const who = pharmacies.length ? ` — ${pharmacies.slice(0, 2).join(' / ')}` : '';
  return [
    `📋 طلبية جديدة بانتظار المراجعة (${rows.length} صنف)${who}`,
    `بانتظارك في التطبيق: صفحة رفع الملفات ← «مراجعة الطلبيات». المجموع المعلَّق: ${pending + 1}.`,
    'لا يُحفَظ أي شيء كمبيعات حتى تراجعها وتؤكدها هناك.',
    `#${created.id}`,
  ].join('\n');
}

/** قائمة خفيفة للشريط — بلا payload.rows (قد تكون عشرات الصفوف). */
export async function listPendingOrders(userId) {
  // تقليم كسول: لا setInterval (لا نفترض عدد نسخ PM2) وidempotent بطبعه.
  const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 86_400_000);
  const stale = await prisma.pendingBotOrder.findMany({
    where: { userId, createdAt: { lt: cutoff } }, select: { id: true, imageFiles: true },
  });
  if (stale.length) {
    await prisma.pendingBotOrder.deleteMany({ where: { id: { in: stale.map(s => s.id) } } });
    for (const s of stale) await unlinkImages(s.imageFiles);
  }

  const rows = await prisma.pendingBotOrder.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, source: true, chatTitle: true, senderName: true, repName: true,
      kind: true, sourceText: true, rowCount: true, imageFiles: true, createdAt: true,
    },
  });

  return rows.map(r => ({
    ...r,
    imageFiles: undefined,
    imageCount: toImageList(r.imageFiles).length,
    // أول صيدلية للعرض في الشريط بلا تحميل كل الصفوف
    preview: (r.sourceText || '').replace(/\s+/g, ' ').slice(0, 120) || null,
  }));
}

/**
 * طلبية واحدة للمراجعة. يُسطّح payload ويحقن الحقول المساعدة كي يصبح الردّ
 * متوافق الشكل مع ما يبنيه المودال من استخراج طازج — نفس خدعة
 * getPendingVisitsImport في doctors.controller.js التي تجعل مساراً واحداً يخدم
 * طريقَي الدخول بلا تفريع.
 */
export async function getPendingOrder(userId, id) {
  const row = await prisma.pendingBotOrder.findFirst({ where: { id: Number(id), userId } });
  if (!row) throw new AppError('الطلبية غير موجودة أو لا تخصّك.', 404, 'ORDER_NOT_FOUND');
  const payload = row.payload || {};
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    extractedAt: payload.extractedAt ?? null,
    repName: row.repName,
    repId: row.repId,
    sourceText: row.sourceText,
    senderName: row.senderName,
    chatTitle: row.chatTitle,
    imageCount: toImageList(row.imageFiles).length,
    createdAt: row.createdAt,
  };
}

/** مسار صورة على القرص بعد التحقق من ملكية الصف — للبثّ عبر نقطة مصادَقة. */
export async function getPendingOrderImagePath(userId, id, index) {
  const row = await prisma.pendingBotOrder.findFirst({
    where: { id: Number(id), userId }, select: { imageFiles: true },
  });
  if (!row) throw new AppError('الطلبية غير موجودة أو لا تخصّك.', 404, 'ORDER_NOT_FOUND');
  const names = toImageList(row.imageFiles);
  const name = names[Number(index)];
  if (!name) throw new AppError('الصورة غير موجودة.', 404, 'IMAGE_NOT_FOUND');
  return path.join(BOT_ORDER_IMAGES_DIR, name);
}

/** إلغاء طلبية معلَّقة بلا حفظ أي شيء منها. */
export async function deletePendingOrder(userId, id) {
  const row = await prisma.pendingBotOrder.findFirst({
    where: { id: Number(id), userId }, select: { id: true, imageFiles: true },
  });
  if (!row) throw new AppError('الطلبية غير موجودة أو لا تخصّك.', 404, 'ORDER_NOT_FOUND');
  await prisma.pendingBotOrder.delete({ where: { id: row.id } });
  await unlinkImages(row.imageFiles);
  return true;
}

/**
 * يُستهلَك الصف بعد حفظ ناجح في insertManualSales — يُستدعى من
 * sales.controller.js. best-effort بالكامل: فشله لا يُسقط نجاح الحفظ.
 */
export async function consumePendingOrder(userId, id) {
  if (!id) return;
  try {
    const row = await prisma.pendingBotOrder.findFirst({
      where: { id: Number(id), userId }, select: { id: true, imageFiles: true },
    });
    if (!row) return;
    await prisma.pendingBotOrder.delete({ where: { id: row.id } });
    await unlinkImages(row.imageFiles);
  } catch (e) {
    console.error('[orders] تعذّر حذف الطلبية المعلَّقة بعد الحفظ:', e?.message);
  }
}
