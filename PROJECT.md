# pharma-sales-analyzer — وصف شامل للمشروع

> **آخر تحديث:** مارس 2026  
> **Production URL:** `https://ordine-sales.up.railway.app`

---

## 1. نظرة عامة

منصة ويب متكاملة لإدارة وتحليل مبيعات المندوبين الطبيين والعلميين.  
تدعم رفع ملفات Excel وتحليلها بالذكاء الاصطناعي، وإدارة الخطط الشهرية، وزيارات الأطباء والصيدليات، والتقارير، وإدارة المستخدمين ضمن نموذج **multi-tenant** (مكاتب + شركات).

---

## 2. التقنيات المستخدمة (Stack)

| الطبقة | التقنية |
|---|---|
| Frontend | React 18 + TypeScript + Vite 5 |
| Styling | Tailwind CSS 4 |
| Backend | Node.js + Express.js (ESM) |
| ORM | Prisma 5 |
| DB (Production) | PostgreSQL (Railway) |
| DB (Local) | SQLite |
| Auth | JWT (jsonwebtoken) + bcryptjs |
| AI | Google Generative AI (Gemini) + OpenAI |
| Maps | Leaflet + react-leaflet |
| File Upload | Multer |
| Excel Parsing | xlsx (SheetJS) |
| Process Manager | PM2 (ecosystem.config.cjs) |
| Deployment | Railway (nixpacks) |

---

## 3. هيكل المجلدات

```
pharma-sales-analyzer/
├── server/                    # الـ Backend - Express.js
│   ├── index.js               # نقطة الدخول الرئيسية للسيرفر
│   ├── lib/
│   │   ├── prisma.js          # Prisma client singleton
│   │   └── fuzzyMatch.js      # مطابقة الأسماء التقريبية
│   ├── middleware/
│   │   ├── authMiddleware.js  # التحقق من JWT
│   │   ├── errorHandler.js    # معالج أخطاء موحد
│   │   ├── superAdminMiddleware.js
│   │   └── validate.js        # Zod validation middleware
│   └── modules/               # وحدات API (كل وحدة: controller + routes + service + repository + dto)
│       ├── auth/              # تسجيل الدخول والخروج
│       ├── users/             # إدارة المستخدمين
│       ├── representatives/   # المندوبون الطبيون (commercial)
│       ├── scientific-reps/   # المندوبون العلميون
│       ├── doctors/           # الأطباء والزيارات
│       ├── monthly-plans/     # الخطط الشهرية
│       ├── sales/             # المبيعات + رفع Excel
│       ├── reports/           # التقارير والتصدير
│       ├── offices/           # المكاتب العلمية
│       ├── companies/         # الشركات
│       ├── admin-users/       # إدارة مستخدمي الأدمن
│       └── super-admin/       # لوحة السوبر أدمن
│
├── src/                       # الـ Frontend - React + TypeScript
│   ├── main.tsx               # نقطة الدخول - يختار App أو SuperAdminApp
│   ├── App.tsx                # التطبيق الرئيسي (للمكاتب والشركات)
│   ├── SuperAdminApp.tsx      # تطبيق السوبر أدمن المستقل
│   ├── context/
│   │   ├── AuthContext.tsx    # حالة المصادقة + بيانات المستخدم
│   │   ├── LanguageContext.tsx # دعم اللغة (عربي/إنجليزي)
│   │   └── SuperAdminContext.tsx
│   ├── components/
│   │   ├── layout/Sidebar.tsx # القائمة الجانبية الديناميكية
│   │   ├── AnalysisRenderer.tsx   # عرض نتائج تحليل الذكاء الاصطناعي
│   │   ├── AnalysisResults.tsx
│   │   ├── DailyCallsMap.tsx     # خريطة زيارات المندوبين (Leaflet)
│   │   ├── FileUpload.tsx        # رفع ملفات Excel
│   │   └── FilterPanel.tsx       # فلترة البيانات
│   ├── pages/
│   │   ├── LoginPage.tsx
│   │   ├── DashboardPage.tsx     # لوحة التحكم الرئيسية
│   │   ├── RepresentativesPage.tsx  # المندوبون الطبيون
│   │   ├── ScientificRepsPage.tsx   # المندوبون العلميون
│   │   ├── DoctorsPage.tsx          # الأطباء + الزيارات
│   │   ├── MonthlyPlansPage.tsx     # الخطط الشهرية
│   │   ├── ReportsPage.tsx          # التقارير
│   │   ├── UsersPage.tsx            # إدارة المستخدمين
│   │   ├── UploadPage.tsx           # رفع ملفات المبيعات
│   │   ├── RepAnalysisPage.tsx      # تحليل المندوب بالذكاء الاصطناعي
│   │   └── super-admin/
│   │       ├── SuperAdminLogin.tsx
│   │       ├── OfficesPage.tsx      # إدارة المكاتب
│   │       ├── CompaniesPage.tsx    # إدارة الشركات
│   │       ├── UsersPage.tsx        # عرض كل المستخدمين
│   │       └── SuperAdminsPage.tsx  # إدارة السوبر أدمنز
│   ├── services/
│   │   ├── aiService.ts        # استدعاءات Gemini/OpenAI
│   │   ├── excelParser.ts      # تحليل ملفات Excel
│   │   └── fileService.ts
│   ├── i18n/translations.ts    # ترجمات عربي/إنجليزي
│   └── types/
│
├── prisma/
│   ├── schema.prisma           # تعريف قاعدة البيانات
│   ├── seed-local-data.js      # بذر بيانات تجريبية محلية
│   └── seed-super-admin.js     # إنشاء حساب سوبر أدمن
│
├── uploads/                    # ملفات المرفوعة (Excel + صور المنتجات)
├── dist/                       # نتيجة build الـ Frontend (gitignored)
├── public/                     # ملفات عامة ثابتة
├── export-local.mjs            # أداة تصدير البيانات من SQLite محلياً
├── import-to-railway.mjs       # أداة استيراد البيانات إلى Railway PostgreSQL
├── ecosystem.config.cjs        # إعداد PM2
├── nixpacks.toml               # إعداد build على Railway
├── railway.json                # تكوين Railway
├── vercel.json                 # تكوين Vercel (fallback)
└── start-backend.vbs           # تشغيل الخادم محلياً على Windows
```

---

## 4. قاعدة البيانات — النماذج الرئيسية

```
User                        — المستخدمون (كل الأدوار)
MedicalRepresentative       — المندوبون الطبيون (commercial)
ScientificRepresentative    — المندوبون العلميون
ScientificOffice            — المكاتب العلمية (tenant)
Company                     — الشركات الدوائية
Doctor                      — الأطباء
DoctorVisit                 — زيارات الأطباء
PharmacyVisit               — زيارات الصيدليات
MonthlyPlan                 — الخطط الشهرية
MonthlyPlanEntry            — إدخالات الخطة الشهرية
MonthlyPlanEntryItem        — بنود الخطة
Sale                        — المبيعات
Item                        — المنتجات/الأصناف
Area                        — المناطق
Customer                    — العملاء
UploadedFile                — ملفات Excel المرفوعة
InvoiceSheet                — كشوف الفاتورة
SuperAdmin                  — حسابات السوبر أدمن
UserCompanyAssignment       — ربط المستخدم بالشركة
UserLineAssignment          — ربط المستخدم بخط المنتجات
UserItemAssignment          — ربط المستخدم بالأصناف
UserAreaAssignment          — ربط المستخدم بالمناطق
UserManagerAssignment       — علاقة المدير-المرؤوس
UserInteractionPermission   — صلاحيات التفاعل بين المستخدمين
```

---

## 5. API Routes (Backend)

| Prefix | Module | الوصف |
|---|---|---|
| `/api/auth` | auth | تسجيل دخول/خروج، تغيير كلمة مرور |
| `/api/users` | users | إدارة المستخدمين |
| `/api/representatives` | representatives | المندوبون الطبيون |
| `/api/scientific-reps` | scientific-reps | المندوبون العلميون + زياراتهم |
| `/api/doctors` | doctors | الأطباء + زيارات + خرائط |
| `/api/monthly-plans` | monthly-plans | الخطط الشهرية |
| `/api/sales` | sales | رفع Excel + استعلام المبيعات |
| `/api/reports` | reports | تقارير متعددة + تصدير |
| `/api/offices` | offices | المكاتب العلمية |
| `/api/companies` | companies | الشركات |
| `/api/admin-users` | admin-users | إدارة مستخدمي المكاتب |
| `/api/sa` | super-admin | لوحة السوبر أدمن |
| `/api/health` | — | فحص حالة الخادم (عام) |

---

## 6. الأدوار والصلاحيات

### أدوار النظام (User.role)

**أدوار المكاتب العلمية:**
- `office_manager` — مدير المكتب العلمي
- `office_hr` — موارد بشرية في المكتب
- `office_employee` — موظف في المكتب

**أدوار الشركات:**
- `company_manager` — مدير الشركة
- `supervisor` — مشرف
- `product_manager` — مدير منتج
- `team_leader` — قائد فريق
- `scientific_rep` — مندوب علمي

**أدوار تجارية:**
- `commercial_supervisor` — مشرف تجاري
- `commercial_team_leader` — قائد فريق تجاري
- `commercial_rep` — مندوب تجاري

**أدوار قديمة (legacy):**
- `admin`, `manager`, `user`

### السوبر أدمن (SuperAdmin)
- كيان مستقل تماماً عن `User`
- يصل عبر `/super-admin` 
- يدير: المكاتب، الشركات، المستخدمين بشكل كلي
- `isMaster: true` — الأدمن الرئيسي (يرى إدارة السوبر أدمنز)

### وضع المراقبة (Impersonation)
- السوبر أدمن يستطيع "تقمص" أي مستخدم لرؤية ما يراه
- يوضع علامة `_is_impersonating` في `sessionStorage`
- يظهر شريط برتقالي في أعلى الشاشة أثناء وضع المراقبة

---

## 7. Multi-Tenancy

النظام يدعم عدة مكاتب وشركات على نفس قاعدة البيانات:

- كل **مكتب علمي** (`ScientificOffice`) يملك مجموعة من المندوبين والمستخدمين والمناطق
- الأصناف والمستخدمون مرتبطون بـ `userId` لضمان عزل البيانات
- يمكن ربط مستخدم بشركة محددة عبر `UserCompanyAssignment`
- الصلاحيات التفصيلية مخزنة بـ JSON في `User.permissions`

---

## 8. صفحات الواجهة الأمامية

| الصفحة | المسار | الوصف |
|---|---|---|
| LoginPage | `/login` | تسجيل الدخول |
| DashboardPage | `/` (default) | لوحة التحكم + إحصائيات |
| RepresentativesPage | — | إدارة المندوبين الطبيين |
| ScientificRepsPage | — | المندوبون العلميون |
| DoctorsPage | — | قائمة الأطباء + سجل الزيارات |
| MonthlyPlansPage | — | الخطط الشهرية للمندوبين |
| ReportsPage | — | تقارير متنوعة |
| UploadPage | — | رفع ملفات Excel للمبيعات |
| RepAnalysisPage | — | تحليل أداء مندوب بالذكاء الاصطناعي |
| UsersPage | — | إدارة المستخدمين |
| **SA Panel** | `/super-admin` | لوحة تحكم السوبر أدمن المستقلة |

---

## 9. ميزة الذكاء الاصطناعي

- يستخدم **Google Gemini** (أو OpenAI كبديل) عبر `src/services/aiService.ts`
- يتلقى ملف Excel من المستخدم → يُحلَّل → يُرسَل للنموذج
- النتائج تُعرض في `AnalysisRenderer.tsx` بصيغة منسقة
- مفاتيح API في `.env`: `GEMINI_API_KEY` أو `OPENAI_API_KEY`

---

## 10. البيئة المحلية (Local Development)

```bash
# تشغيل كليهما (frontend + backend)
npm run dev
# أو منفصلين:
npm run server   # Backend على port 8080
npm run client   # Frontend (Vite) على port 5175

# قاعدة البيانات
npm run db:push     # تطبيق schema على SQLite
npm run db:studio   # Prisma Studio
npm run db:migrate  # إنشاء migration جديدة
```

**متطلبات `.env` محلياً:**
```env
DATABASE_URL="file:./dev.db"
JWT_SECRET=your_secret_here
GEMINI_API_KEY=your_key_here
NODE_ENV=development
```

---

## 11. النشر على Railway

- **Build:** `npm install --include=dev` ثم `npm run build` (nixpacks.toml)
- **Start:** `npx prisma db push && npm start`
- **Provider:** يجب أن يكون `postgresql` في `schema.prisma` عند الـ push
- **قاعدة مهمة:** لا تُحدِّث `prisma/schema.prisma` إلى `sqlite` ثم تعمل `git push`
- **إعادة نشر إجباري:**
  ```bash
  git commit --allow-empty -m "chore: trigger redeploy"
  git push origin main
  ```

---

## 12. ملفات الإعداد المهمة

| الملف | الغرض |
|---|---|
| `prisma/schema.prisma` | تعريف كامل لقاعدة البيانات |
| `server/index.js` | إعداد Express + كل الـ routes |
| `vite.config.ts` | إعداد Vite build |
| `tailwind.config.js` | إعداد Tailwind |
| `nixpacks.toml` | أوامر build على Railway |
| `ecosystem.config.cjs` | إعداد PM2 |
| `nodemon.json` | أوامر إعادة التشغيل التلقائي (dev) |
| `.env` | المتغيرات السرية (لا تُكمِّت) |
| `.env.example` | مثال على المتغيرات المطلوبة |
| `export-local.mjs` | تصدير بيانات SQLite المحلية |
| `import-to-railway.mjs` | استيراد البيانات إلى Railway |

---

## 13. أخطاء TypeScript معروفة (موجودة مسبقاً)

هذه الأخطاء موجودة قبل أي تعديل وتُتجاهَل:
- `src/context/LanguageContext.tsx` — تعارض نوع الترجمة (TS2719)
- `src/pages/Dashboard.tsx` — مكونات مفقودة
- `src/services/aiService.ts` — أنواع مفقودة

---

## 14. ملاحظات أمان

- كلمات المرور مُشفَّرة بـ `bcryptjs`
- كل routes محمية بـ `requireAuth` middleware (JWT)
- routes السوبر أدمن محمية بـ `superAdminMiddleware`
- حجم upload محدود بـ 5MB للصور و 50MB للـ JSON
- لا يُخزَّن رمز JWT في `localStorage` — يُستخدَم في headers فقط
