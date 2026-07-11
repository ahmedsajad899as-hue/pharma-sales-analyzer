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

## Stack

React 18 + TS + Vite 5 + Tailwind 4 (frontend) · Express.js ESM + Prisma 5 + PostgreSQL (Railway) (backend) · JWT + bcryptjs auth · Gemini (3 مفاتيح API للتوزيع: `GEMINI_API_KEY_1/2/3`) + OpenAI كبديل · Leaflet للخرائط · xlsx لتحليل Excel · PM2 (`ecosystem.config.cjs`) · نشر على Railway عبر nixpacks.

## تشغيل محلي

```bash
npm run dev          # frontend (5175) + backend (8080) معاً
npm run server       # backend فقط (nodemon)
npm run client       # frontend فقط (vite)
npm run db:push       # طبّق schema.prisma على DATABASE_URL
npm run db:studio
```

`.env` المطلوب: `DATABASE_URL`, `JWT_SECRET`, `GEMINI_API_KEY_1..3`, `PORT`, `NODE_ENV`, `ORS_API_KEY` (OpenRouteService — مذكور في `.env` لكن غير موثّق في PROJECT.md، يُستخدم للـ routing/tracking).

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
