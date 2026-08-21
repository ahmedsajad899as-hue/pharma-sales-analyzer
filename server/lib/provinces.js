/**
 * المحافظات (Provinces) — المستوى الجغرافي فوق Area.
 *
 * لماذا مستوى منفصل: ملفات الإكسل تحمل عمودين للموقع — «محافظة» (بغداد/الموصل)
 * و«الموقع»/«المنطقة» (الحارثية / شارع الكندي). قبل هذا الملف كان الاثنان
 * aliases لنفس الحقل area في COLUMN_ALIASES، فيفوز عمود واحد ويُهمل الآخر.
 *
 * Province عالمي (بلا userId) بعكس Area: محافظات العراق ثابتة ومشتركة بين كل
 * الحسابات، بينما Area مُنطاقة لكل مستخدم عبر @@unique([name, userId]).
 */

import { normalizeAreaName } from './itemResolver.js';

/**
 * محافظات العراق الـ18 + الأسماء البديلة الشائعة في ملفات المبيعات.
 * الاسم البديل غالباً هو مركز المحافظة (الموصل ← نينوى) لأن الملفات تكتب
 * اسم المدينة لا اسم المحافظة الرسمي.
 */
export const IRAQ_PROVINCES = [
  { name: 'بغداد',      sortOrder: 1,  aliases: [] },
  { name: 'البصرة',     sortOrder: 2,  aliases: ['بصرة'] },
  { name: 'نينوى',      sortOrder: 3,  aliases: ['الموصل', 'موصل'] },
  { name: 'أربيل',      sortOrder: 4,  aliases: ['اربيل', 'هولير', 'erbil'] },
  { name: 'السليمانية', sortOrder: 5,  aliases: ['سليمانية'] },
  { name: 'دهوك',       sortOrder: 6,  aliases: ['duhok'] },
  { name: 'كركوك',      sortOrder: 7,  aliases: [] },
  { name: 'ديالى',      sortOrder: 8,  aliases: ['بعقوبة', 'ديالي'] },
  { name: 'الأنبار',    sortOrder: 9,  aliases: ['الانبار', 'الرمادي', 'الفلوجة'] },
  { name: 'بابل',       sortOrder: 10, aliases: ['الحلة'] },
  { name: 'كربلاء',     sortOrder: 11, aliases: [] },
  { name: 'النجف',      sortOrder: 12, aliases: ['نجف'] },
  { name: 'واسط',       sortOrder: 13, aliases: ['الكوت', 'كوت'] },
  { name: 'صلاح الدين', sortOrder: 14, aliases: ['تكريت', 'سامراء'] },
  { name: 'القادسية',   sortOrder: 15, aliases: ['الديوانية', 'ديوانية'] },
  { name: 'ميسان',      sortOrder: 16, aliases: ['العمارة', 'عمارة'] },
  { name: 'ذي قار',     sortOrder: 17, aliases: ['الناصرية', 'ناصرية', 'ذيقار'] },
  { name: 'المثنى',     sortOrder: 18, aliases: ['السماوة', 'سماوة'] },
];

/**
 * ترويسات عمود المحافظة في ملفات الإكسل. مُصدَّرة هنا لأن مستهلكَين يحتاجانها:
 * COLUMN_ALIASES.province في sales.service.js، و autoMatchProvinces أدناه الذي
 * يقرأ Sale.rawData (الصف الأصلي المحفوظ كـ JSON).
 */
export const PROVINCE_COLUMN_ALIASES = [
  'governorate', 'province', 'state', 'muhafaza',
  'المحافظة', 'محافظة', 'المحافظه', 'محافظه',
];

/** يبني خريطة: الاسم المطبَّع (للاسم الرسمي وكل alias) ← صف المحافظة. */
export function buildProvinceLookup(provinceRows) {
  const map = new Map();
  for (const p of provinceRows) {
    map.set(normalizeAreaName(p.name), p);
    let aliases = [];
    try { aliases = JSON.parse(p.aliases || '[]'); } catch { aliases = []; }
    for (const a of aliases) {
      const k = normalizeAreaName(a);
      if (k && !map.has(k)) map.set(k, p);
    }
  }
  return map;
}

/** يحلّ اسم محافظة خام (من ملف) إلى صف Province، أو null. */
export function matchProvinceName(rawName, lookup) {
  const key = normalizeAreaName(rawName || '');
  return key ? (lookup.get(key) || null) : null;
}

/**
 * بذر المحافظات الـ18 — idempotent، يُستدعى مرة عند إقلاع السيرفر.
 * التحديث يقتصر على aliases/sortOrder حتى لا يُلغى أي تعديل اسم من المدير.
 */
export async function seedProvinces(prisma) {
  for (const p of IRAQ_PROVINCES) {
    await prisma.province.upsert({
      where:  { name: p.name },
      update: { aliases: JSON.stringify(p.aliases), sortOrder: p.sortOrder },
      create: { name: p.name, aliases: JSON.stringify(p.aliases), sortOrder: p.sortOrder },
    });
  }
  return prisma.province.count();
}

/**
 * إسناد محافظة لكل منطقة بلا محافظة — مرحلتان، الأقوى أولاً:
 *
 *  1) من Sale.rawData: الصف الأصلي محفوظ كـ JSON عند كل رفع، فيه عمود المحافظة
 *     حتى لو أهمله المحلّل وقتها. نصوّت بالأغلبية لكل منطقة لأن نفس المنطقة قد
 *     ترد بمحافظات مختلفة عبر ملفات متعددة.
 *  2) مطابقة اسم المنطقة نفسه بالاسم الرسمي أو alias — تطابق تام بعد التطبيع، أو
 *     «يبدأ بـ alias + مسافة». لا مطابقة جزئية أوسع: التطبيع يحذف «ال» البادئة،
 *     والمطابقة الفضفاضة سبّبت أخطاء موثّقة سابقاً (راجع admin-users.controller.js).
 *
 * ما لا يُطابَق يبقى provinceId = null («غير محدد») ليصنّفه المدير يدوياً.
 */
export async function autoMatchProvinces(prisma, opts = {}) {
  const { onlyUnassigned = true } = opts;
  const EMPTY = { matchedFromSales: 0, matchedFromName: 0, unresolved: 0, scanned: 0 };

  const provinces = await prisma.province.findMany();
  if (provinces.length === 0) return EMPTY;
  const lookup = buildProvinceLookup(provinces);

  const areas = await prisma.area.findMany({
    where:  onlyUnassigned ? { provinceId: null } : {},
    select: { id: true, name: true },
  });
  if (areas.length === 0) return EMPTY;

  const areaIds = areas.map(a => a.id);
  const resolved = new Map(); // areaId -> provinceId

  // 1) تصويت بالأغلبية من Sale.rawData
  // نقرأ على دفعات: rawData نص JSON كامل لكل صف، وجلبه دفعة واحدة لكل المبيعات
  // قد يكون ثقيلاً على حساب فيه مئات آلاف الصفوف.
  const normAliasSet = new Set(PROVINCE_COLUMN_ALIASES.map(a => a.toLowerCase().trim()));
  const votes = new Map(); // areaId -> Map(provinceId -> count)
  const CHUNK = 25;

  for (let i = 0; i < areaIds.length; i += CHUNK) {
    const chunk = areaIds.slice(i, i + CHUNK);
    const sales = await prisma.sale.findMany({
      where:  { areaId: { in: chunk }, rawData: { not: null } },
      select: { areaId: true, rawData: true },
      take:   20000,
    });
    for (const s of sales) {
      let raw;
      try { raw = JSON.parse(s.rawData); } catch { continue; }
      if (!raw || typeof raw !== 'object') continue;

      // ابحث عن أي مفتاح ترويسته ضمن aliases عمود المحافظة
      let provinceRaw = null;
      for (const [k, v] of Object.entries(raw)) {
        if (normAliasSet.has(String(k).toLowerCase().trim()) && v != null && String(v).trim()) {
          provinceRaw = String(v);
          break;
        }
      }
      if (!provinceRaw) continue;

      const p = matchProvinceName(provinceRaw, lookup);
      if (!p) continue;
      if (!votes.has(s.areaId)) votes.set(s.areaId, new Map());
      const m = votes.get(s.areaId);
      m.set(p.id, (m.get(p.id) || 0) + 1);
    }
  }

  for (const [areaId, m] of votes) {
    let bestId = null, bestCount = -1;
    for (const [pid, count] of m) if (count > bestCount) { bestId = pid; bestCount = count; }
    if (bestId != null) resolved.set(areaId, bestId);
  }
  const matchedFromSales = resolved.size;

  // 2) مطابقة اسم المنطقة نفسه
  for (const a of areas) {
    if (resolved.has(a.id)) continue;
    const norm = normalizeAreaName(a.name);
    if (!norm) continue;

    let hit = lookup.get(norm) || null;
    if (!hit) {
      // «الموصل الجديدة» يبدأ بـ «موصل » بعد التطبيع
      for (const [key, p] of lookup) {
        if (key && norm.startsWith(key + ' ')) { hit = p; break; }
      }
    }
    if (hit) resolved.set(a.id, hit.id);
  }
  const matchedFromName = resolved.size - matchedFromSales;

  // 3) الكتابة
  const byProvince = new Map(); // provinceId -> areaId[]
  for (const [areaId, pid] of resolved) {
    if (!byProvince.has(pid)) byProvince.set(pid, []);
    byProvince.get(pid).push(areaId);
  }
  for (const [pid, ids] of byProvince) {
    await prisma.area.updateMany({ where: { id: { in: ids } }, data: { provinceId: pid } });
  }

  return {
    matchedFromSales,
    matchedFromName,
    unresolved: areas.length - resolved.size,
    scanned:    areas.length,
  };
}
