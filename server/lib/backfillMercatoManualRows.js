import prisma from './prisma.js';
import { repCoreName } from './repNameMatch.js';
import { resolveMercatoHeaders, MERCATO_READY_STATUS, cleanPharmacyName, isManualInvoiceSource } from '../modules/sales/sales.service.js';
import { findRepByName } from '../modules/sales/sales.repository.js';

const normalizeAr = s => String(s ?? '')
  .trim()
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ـ/g, '')
  .replace(/[ً-ٟ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// manual-invoice (يدوي/صورة) + telegram-order/viber-order (طلبيات البوت)
const MANUAL_SOURCE_FILTERS = ['manual-invoice', 'telegram-order', 'viber-order']
  .map(v => ({ rawData: { contains: `"source":"${v}"` } }));

/**
 * يرحّل مبيعات الفواتير اليدوية القديمة داخل ملفات ميركاتو إلى الشكل الجديد:
 * القيم تُكتب تحت ترويسات الملف (رقم طلبية المذخر، حالتها «جاهزة للتسليم»، اسم
 * الشركة = الصيدلية، اسم المادة بالمكتب، البونص، السعر، اسم المذخر) ويصير «اسم
 * المندوب» المندوبَ العلمي المختار عند التحليل. إضافي وidempotent: الصف المرحَّل
 * يحمل _mercatoShaped فلا يُمسّ ثانيةً، فتشغيله عند كل إقلاع بلا كتابة بعد أول مرة.
 * @returns {Promise<number>} عدد الصفوف المرحَّلة
 */
export async function backfillMercatoManualRows() {
  // ملفات فيها صفوف يدوية غير مرحَّلة — كل الملفات لا الموسومة sourceSystem='mercato'
  // فقط: ملف ميركاتو التراكمي قد لا يحمل الوسم، والاكتشاف الفعلي من ترويسات صفوفه
  // (resolveMercatoHeaders) يُعيد null لأي ملف ليس ميركاتو فيُتخطّى.
  const pending = await prisma.sale.findMany({
    where: { OR: MANUAL_SOURCE_FILTERS, NOT: { rawData: { contains: '_mercatoShaped' } } },
    select: { uploadedFileId: true }, distinct: ['uploadedFileId'],
  });
  const fileIds = pending.map(p => p.uploadedFileId).filter(Boolean);
  const files = fileIds.length
    ? await prisma.uploadedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, userId: true } })
    : [];
  console.log(`[backfillMercatoManualRows] ملفات فيها صفوف يدوية غير مرحَّلة: ${files.length}`);
  let fixed = 0;
  for (const file of files) {
    const manual = await prisma.sale.findMany({
      where: {
        uploadedFileId: file.id,
        OR: MANUAL_SOURCE_FILTERS,
        NOT: { rawData: { contains: '_mercatoShaped' } },
      },
      select: {
        id: true, userId: true, quantity: true, totalValue: true, rawData: true, saleDate: true,
        item: { select: { name: true } }, area: { select: { name: true } }, customer: { select: { name: true } },
        representative: { select: { name: true } },
      },
    });
    if (!manual.length) continue;
    const h = await resolveMercatoHeaders({ fileId: file.id }, file.userId);
    if (!h) { console.log(`[backfillMercatoManualRows] ملف ${file.id}: ليس ميركاتو (${manual.length} صف يدوي تُرك)`); continue; }

    for (const s of manual) {
      try {
        let raw; try { raw = JSON.parse(s.rawData); } catch { continue; }
        if (!isManualInvoiceSource(raw?.source)) continue;
        const sciRep = raw.scientificRep ? (repCoreName(String(raw.scientificRep)) || String(raw.scientificRep).trim()) : '';
        const itemName = s.item?.name ?? '';
        const price = Number(raw.unitPrice) || (s.quantity ? Math.round((s.totalValue / s.quantity) * 100) / 100 : 0);
        const patch = {
          [h.orderNumber]: raw.invoiceNumber ?? '',
          [h.orderStatus]: MERCATO_READY_STATUS,
          [h.date]:        s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : '',
          [h.customer]:    cleanPharmacyName(raw.pharmacy ?? s.customer?.name ?? ''),
          [h.area]:        s.area?.name ?? '',
          [h.repName]:     sciRep || s.representative?.name || '',
          [h.company]:     itemName,
          [h.item]:        itemName,
          [h.quantity]:    s.quantity,
          [h.bonusQty]:    Number(raw.bonus) || 0,
          [h.unitPrice]:   price || '',
          [h.totalValue]:  s.totalValue,
          [h.warehouse]:   raw.warehouse ?? '',
          _mercatoShaped:  true,
        };
        const data = { rawData: JSON.stringify({ ...patch, ...raw }) };
        // المندوب العلمي المختار يحلّ محلّ حساب الكروب كمندوب للصف
        if (sciRep && normalizeAr(sciRep) !== normalizeAr(s.representative?.name)) {
          const owner = s.userId ?? file.userId;
          const name = normalizeAr(sciRep);
          const rep = (await findRepByName(name, owner))
            ?? (await prisma.medicalRepresentative.create({ data: { name, userId: owner } }));
          data.representativeId = rep.id;
        }
        await prisma.sale.update({ where: { id: s.id }, data });
        fixed++;
      } catch (e) {
        console.error('[backfillMercatoManualRows] sale', s.id, e.message);
      }
    }
  }
  return fixed;
}
