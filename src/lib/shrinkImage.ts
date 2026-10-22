// shrinkImage.ts — تصغير صورة قبل رفعها لقراءتها بالذكاء الاصطناعي (Claude).
// Claude يرفض الصورة فوق ~5MB ولا يقبل HEIC، وصور كاميرا الهاتف تتجاوز ذلك كثيراً.
// نصغّرها في المتصفح (لا على السيرفر — ذاكرته 951MB) إلى 2000px كحد أقصى JPEG،
// وهي دقة كافية لقراءة نص الفاتورة الصغير.

const MAX_DIM = 2000;
const QUALITY = 0.85;

export async function shrinkImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    // صورة صغيرة بصيغة مقبولة — تُرفع كما هي
    if (scale === 1 && file.size < 3_500_000 && /^image\/(jpeg|png|webp)$/.test(file.type)) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', QUALITY));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file; // متصفح لا يفكّ هذه الصيغة — يُرفع الأصل ويُبلغ السيرفر بالخطأ
  }
}
