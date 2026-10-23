# pharma-sales-analyzer — مرجع سريع لـ Claude Code

> راجع أيضاً [PROJECT.md](PROJECT.md) لشرح أشمل بالعربي — لكنه **قديم** (مارس 2026) ولا يعكس كل الموديولات الحالية. اعتبر هذا الملف هو المصدر الأدق لأنه مُحدَّث من الكود الفعلي.

## ⚠️ النشر: Vultr (ليس Railway) — يدوي عبر deploy.ps1

المشروع انتقل في 2026-06-20 من Railway إلى سيرفر Vultr خاص (`199.247.0.207`, PM2 process `pharma-sales`, خلف Nginx). Railway تم إلغاؤه فعلياً (الدومين القديم `ordine-sales.up.railway.app` يرجّع 404 الآن). مراقب `auto-deploy.ps1` (النسخة القديمة auto-push كل 5 دقائق على Railway) **معطّل** (`.vbs.disabled` بمجلد Startup).

النشر الحالي يتم عبر [deploy.ps1](deploy.ps1) (يدوي، لكن يجب تشغيله بعد كل تعديل كود بدون انتظار طلب المستخدم — راجع الذاكرة): `git push` ثم بناء محلي (`npm run build`) ثم نقل الكود/dist عبر scp إلى `/var/www/pharma-sales-analyzer` ثم `pm2 restart pharma-sales`. **أي تعديل هنا لن يظهر على الإنتاج تلقائياً — يجب تشغيل `./deploy.ps1 "رسالة"` صراحةً.**

## ⚠️ ملفان لـ Prisma schema — يجب أن يتطابقا يدوياً

- `prisma/schema.prisma` — يُستخدم لـ `db:push` / `db:studio` / `db:migrate` محلياً.
- `prisma/schema.postgresql.prisma` — يُستخدم فعلياً في:
  - `postinstall` في [package.json](package.json) (`prisma generate --schema prisma/schema.postgresql.prisma`)
  - بناء/تشغيل Railway في [nixpacks.toml](nixpacks.toml) (generate + db push + seed كلها بـ `--schema prisma/schema.postgresql.prisma`)

كلا الملفين provider = postgresql الآن (وُجد `pharma_sales.db` قديم من زمن SQLite، لكن DATABASE_URL الحالي في `.env` يشير لـ Postgres حتى محلياً). **عند تعديل الـ schema، عدّل الملفين معاً** — لوحظ أنهما غير متطابقين تماماً حالياً (حقول/علاقات مفقودة بين الإثنين، مثل `ActivityLog`, `FilterPreset`, `SalesDataFile`, `commercial module relations`). تحقق بـ `diff prisma/schema.prisma prisma/schema.postgresql.prisma` قبل أي تعديل على الموديلات.

## الملف التراكمي (Cumulative file) — رفع المبيعات/الإرجاع

منذ 2026-10-12 لم تعد كل رفعة إكسل تُنشئ `UploadedFile` مستقلاً. الافتراضي أن الرفعة
**تنصهر** في ملف تراكمي واحد لكل `(userId × sourceSystem × detectedCurrency)` —
`UploadedFile.isCumulative=true` + `mergeGroup`. المصدر والعملة يفصلان المجموعات ولا
يجوز خلطهما (نسبة مندوب ميركاتو ≠ المكتب، والتقارير تُطبّع القيمة بعملة الملف).

- `server/lib/saleFingerprint.js` — بصمة الصف: مفتاح محتوى (رقم الطلبية + نص التاريخ
  الخام + الصيدلية + الشركة + `itemId` + `recordType` + الكمية والقيمة) **+ رقم تكراره
  داخل الرفعة**. الترقيم هو ما يُبقي التكرار المشروع داخل الملف الواحد ويُسقط إعادة
  الرفع بالكامل — راجع `crossFileDedup.js` للدرس المدفوع ثمنه.
- `Sale.dedupKey` + `@@unique([uploadedFileId, dedupKey])` — منع التكرار يقع في قاعدة
  البيانات عبر `createMany({ skipDuplicates: true })`، لا بفحص في ذاكرة السيرفر.
- `server/lib/cumulativeFile.js` — مسار الرفع. `server/lib/cumulativeMerge.js` — دمج
  الملفات القائمة يدوياً (`POST /api/files/merge`, `GET /api/files/merge-preview`).
- `FileMergeBatch` — سجلّ كل رفعة داخل الملف (اسمها، كم أُضيف/أُسقط، أشهرها، ملف
  القرص الأصلي) + تراجع عن رفعة واحدة: `DELETE /api/files/:id/batches/:batchId`.
- `standalone=1` في `POST /api/upload-sales` يُلغي الانصهار لرفعة بعينها.
- اختبار: `npm run test:fingerprint`.

### الصفوف بلا تاريخ + شريحة الشهر

`server/lib/salesMonths.js`. الصف الذي لم يحمل الإكسل له تاريخاً كان يأخذ
`@default(now())` أي لحظة الرفع؛ داخل ملف يُرفع عليه كل شهر هذا يجعله «مبيعاً» في شهر
الرفع. صار يُكتب بعلامة حارسة صريحة `UNDATED_SENTINEL` (1970-01-01)، وحارسُ «بلا
تاريخ» في `/api/reports/overall` يستعمل `UNDATED_CUTOFF` للملفات التراكمية بدل مقارنة
`uploadedAt` (التي تتحرّك مع كل رفعة فتفسد).

شرائح الشهر: `GET /api/sales/months?fileIds=…` + `src/components/MonthChips.tsx`.
الافتراضي = آخر شهر فيه بيانات. تُمرَّر كـ`month` إلى `/api/reports/overall` و
`/api/reports/representative/:id` و`/api/scientific-reps/:id/report` **ولمسارات
التصدير معها** — افتراق التصدير عن الشاشة علّة متكررة هنا.

## Stack

React 18 + TS + Vite 5 + Tailwind 4 (frontend) · Express.js ESM + Prisma 5 + PostgreSQL (Railway) (backend) · JWT + bcryptjs auth · Claude Sonnet 5.5 عبر `server/lib/claudeAi.js` (`callAI`، مفتاح `ANTHROPIC_API_KEY`) — أُلغي Gemini في 2026-10-22 · صور الفواتير (قراءة/اتجاه/سطر الزبون) بـ Qwen-VL عبر `server/lib/qwenAi.js` (`DASHSCOPE_API_KEY`، `QWEN_MODEL`) وClaude احتياطي عند فشله (`callInvoiceAI` في sales.service.js) · Leaflet للخرائط · xlsx لتحليل Excel · PM2 (`ecosystem.config.cjs`) · نشر على Railway عبر nixpacks.

## تشغيل محلي

```bash
npm run dev          # frontend (5175) + backend (8080) معاً
npm run server       # backend فقط (nodemon)
npm run client       # frontend فقط (vite)
npm run db:push       # طبّق schema.prisma على DATABASE_URL
npm run db:studio
```

`.env` المطلوب: `DATABASE_URL`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `DASHSCOPE_API_KEY`, `PORT`, `NODE_ENV`, `ORS_API_KEY` (OpenRouteService — مذكور في `.env` لكن غير موثّق في PROJECT.md، يُستخدم للـ routing/tracking).

## موديولات Backend الفعلية (server/modules/) — أوسع من ما هو موثّق في PROJECT.md

```
admin-users  ai-assistant  auth  bonus-sales  commercial  companies
company-members  distributor-sales  doctor-archive  doctors  item-analysis
master-survey  monthly-plans  offices  pharmacy-analysis  reports
representatives  sales  scientific-reps  super-admin  targets  tracking  users
```

كل موديول: `controller + routes + service + repository + dto` (نفس النمط الموصوف في PROJECT.md).

## مسارات API الفعلية (من server/index.js)

```
/api/auth                  /api/super-admin            /api/super-admin/surveys
/api/sa/offices            /api/sa/companies           /api/sa/users
/api/admin/users           /api/representatives        /api/scientific-reps
/api/reports               /api/doctors                /api/monthly-plans
/api/ai-assistant          /api/commercial             /api/tracking
/api/master-surveys        /api/company-members        /api/distributor-sales
/api/doctor-archive        /api/pharmacy-analysis       /api/item-analysis
/api/targets               /api/bonus-sales            /api  (salesRoutes)
/api/health
```

## صفحات Frontend الفعلية (src/pages/) — أوسع من ما هو موثّق في PROJECT.md

تشمل أيضاً: `BonusSalesPage, CommercialRepPage, DistributorSalesPage, FMSPage, FileFilterPage, ItemInsightTab, ItemsPage, PharmacyAnalysisPage, SalesDataPage, SurveyPage, TargetsPage` بالإضافة لما هو موثق في PROJECT.md.

## ملاحظة حول PROJECT.md

PROJECT.md آخر تحديث مارس 2026 ولا يذكر ~10 موديولات backend و~10 صفحات frontend موجودة فعلياً في الكود (راجع القسمين أعلاه). استخدمه لفهم البنية العامة والأدوار/الصلاحيات (دقيق على الأغلب) لكن لا تعتمد عليه لقائمة الموديولات/الصفحات/الـAPI الكاملة — اعتمد على الكود مباشرة أو هذا الملف.
