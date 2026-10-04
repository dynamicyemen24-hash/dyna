# DyPOS System Architecture
## Enterprise Cloud & Edge Logic

### 1. Multi-Tenant Isolation
DyPOS uses a **Shared Database, Shared Schema** approach with **Row Level Security (RLS)**.
- Every authenticated request sets a session variable: `SET LOCAL app.tenant_id = '...'`.
- PostgreSQL Policies ensure that a tenant can never see another tenant's data, even at the SQL query level.

### 2. Offline-First Synchronization
POS terminals work locally and sync when online.
- **Sequence Guards:** Every operation has a device-specific sequence number to prevent replay attacks.
- **Idempotency:** The `accept_sync_operation` function uses SHA-256 hashes of payloads to ignore duplicate sync attempts.
- **Conflict Resolution:** Strategy-based resolution (`server_wins`, `client_wins`, `merge`) stored in `sync_conflict_resolutions`.

### 3. Double-Entry Accounting
Every financial transaction (Sale, Purchase, Expense) triggers a set of Journal Entries.
- **Ledger Integrity:** The `assert_balanced_journal` constraint trigger ensures that total debits always equal total credits before a transaction is committed.
- **Period Management:** Journals are locked to an `accounting_period` and cannot be edited once the period is closed.

### 4. Inventory Governance
- **Immutable Ledger:** Stock is managed through `stock_movements`. The `products.stock` column is a cached sum updated via triggers.
- **Audit Trail:** Every stock adjustment must reference a reason code and an actor.

### 5. AI-Powered Analytics
- **Gemini Pro Integration:** Used for processing natural language queries about sales data and generating business intelligence summaries.
- **Server-Side Security:** API keys are never exposed to the frontend; all AI calls are proxied through the server.
القطاعات    Capabilities مخصصة
الأولوية	المنشأة	الوظيفة التي تجعل POS مختلفًا
🔥 1	الصيدليات	وصفات، بدائل، تشغيلات، صلاحية، Batch/FEFO، تنبيهات
🔥 2	الورش وميكانيكا السيارات	Work Order، السيارة، الأعطال، قطع الغيار، الفني، مراحل الإصلاح
🔥 3	الصالونات والحلاقين والسبا	مواعيد، كرسي/موظف، خدمات، عمولات، باقات وعضويات
🔥 4	المغاسل والتنظيف الجاف	استلام قطعة، تذكرة، باركود، مراحل، تسليم، وزن، فقد/تلف
🔥 5	متاجر الإلكترونيات والجوالات	IMEI/Serial، ضمان، إصلاح، استبدال، أجهزة مستعملة
🔥 6	محلات قطع السيارات	توافق القطعة مع السيارة، SKU، بدائل، مخزون متعدد
🔥 7	محلات مواد البناء والأدوات	بيع بالقطعة/متر/طن، قياسات، قص، تحميل، توصيل
🔥 8	محلات الأثاث	معرض + طلب تصنيع + ألوان/خامات + عربون + توصيل وتركيب
🔥 9	المخابز والحلويات	إنتاج، وصفات، Batch، صلاحية، طلبات مسبقة، وزن
🔥 10	محلات اللحوم والأسماك	وزن، تقطيع، أجزاء، سعر متغير، هالك، تتبع
🔥 11	محلات الزهور والهدايا	تركيب باقات، مناسبات، طلبات مخصصة، توصيل
🔥 12	المطابع	ملف/تصميم، مقاسات، خامة، عدد، إنتاج، تسعير
🔥 13	الورش الحرفية	أمر تصنيع، مواد، مراحل، عامل، تكلفة
🔥 14	النوادي والجيم	اشتراكات، دخول، تجميد، باقات، مدربين
🔥 15	الفنادق والشقق	حجز، غرفة، Folio، خدمات، Checkout
🔥 16	تأجير السيارات والمعدات	أصل مؤجر، مدة، تأمين، عداد، غرامات
🔥 17	العيادات ومراكز الخدمات	مواعيد، خدمة، مقدم الخدمة، دفعات، ملفات
🔥 18	محلات النظارات	وصفة، إطار، عدسات، قياسات، طلب تصنيع
🔥 19	متاجر المجوهرات والساعات	Serial، وزن، أحجار، شهادة، تقييم، إصلاح
🔥 20	الجملة والتوزيع	أسعار شرائح، مندوبين، آجال، مسارات توزيع

هذه ليست أفكارًا نظرية فقط؛ أنظمة POS المتخصصة الحالية تميز بالفعل بين الصيدليات، الموضة، الأجهزة، العتاد، المطاعم، الصالونات، المغاسل، السيارات وغيرها لأن دورة العمل والبيانات تختلف جذريًا.

لكن عندك فرصة أكبر بكثير

بدل أن تجعل النظام:

POS للمطعم + POS للخياطة + POS للصيدلية + POS للورشة...

ابنه كالتالي:

Commerce OS

ثم قدرات مستقلة:

Product Engine
Service Engine
Customer/Party Engine
Measurement Engine
Appointment Engine
Work Order Engine
Production Engine
Rental Engine
Subscription Engine
Prescription/Controlled Inventory Capability
Serial/IMEI Engine
Batch/Expiry Engine
Weighing Engine
Commission Engine
Delivery Engine
Booking Engine
Ledger Engine
Workflow Engine
Device/IoT Engine
Offline Engine

ثم المنشأة تركّب ما تحتاجه فقط.

وهذا متوافق مع الواقع: كثير من الأنشطة تجمع منتجات + خدمات في نفس العملية؛ مثل الصالون الذي يبيع منتجًا ويقدم خدمة، والورشة التي تبيع قطعة وتقدم إصلاحًا.

والأذكى: لا تجعل المستخدم يختار كل ذلك يدويًا

عند التسجيل:

ما نوع نشاطك؟

مثلاً: محل خياطة وبيع ملابس.

النظام يبني تلقائيًا:

Retail + Tailoring + Measurements + Work Orders + Inventory + Customer Profiles + Alterations + Payments

إذا قال:

محل ملابس وخياطة وتطريز

يضيف:

Embroidery Workflow + Production + Outsourcing/Third Party

إذا قال:

ورشة خياطة وبيع أقمشة

يضيف:

Fabric Inventory + Measurement + Production + Retail

وهنا تصبح لديك ميزة تنافسية قوية جدًا:

النظام لا يسأل "أي Module تريد؟" — النظام يفهم نشاطك ويقترح بيئة التشغيل المناسبة.

وهذه هي النقلة التي أراها أهم من إضافة 50 شاشة جديدة.

## طبقة القطاعات القابلة للتركيب في DyPOS

أصبح اختيار النشاط نقطة تكوين واحدة بدل ربط الشاشات بقطاع واحد. يحفظ النظام
ملف النشاط محليًا، ويستخرج منه القدرات المفعّلة التي يمكن لأي شاشة أو سير عمل
استخدامها:

- `product` المنتجات
- `service` الخدمات
- `customer` العملاء
- `measurement` المقاسات
- `appointment` المواعيد
- `work_order` أوامر العمل
- `production` الإنتاج
- `batch_expiry` التشغيلات والصلاحية
- `serial_imei` الأرقام التسلسلية
- `weighing` الوزن
- `commission` العمولات
- `delivery` التوصيل
- `subscription` الاشتراكات
- `workflow` سير العمل
- `ledger` الحسابات

تبدأ عملية التسجيل بملف **متجر تجزئة** افتراضي آمن، ثم يمكن تغيير النشاط من
إعدادات نقطة البيع. اختيار «الخياطة والملابس» مثلًا يفعّل المقاسات وأوامر
العمل والإنتاج تلقائيًا، بينما يفعّل اختيار «الصيدليات» التشغيلات والصلاحية
والوصفات. هذا لا يوقف البيع دون اتصال ولا يحمّل وحدات غير مطلوبة.

المرجع البرمجي:

- `POS/src/config/industryProfiles.js` لتعريف القطاعات والقدرات.
- `POS/src/stores/industryProfile.js` لحفظ النشاط محليًا وتوفير `hasCapability`.
- `POS/src/components/settings/IndustryProfilePicker.vue` لاختيار النشاط.

القاعدة التالية للتوسع: أي ميزة قطاعية جديدة تُضاف كقدرة مستقلة، ثم تُربط
بملفات النشاط المناسبة، ولا تُنسخ داخل شاشة قطاعية منفصلة.

## Commerce OS — المستوى المؤسسي

الطبقة الحالية هي بداية منصة تركيب وليست قائمة قطاعات ثابتة. التصميم المستهدف
يتكون من أربع طبقات مستقلة:

1. **Capability Registry**: تعريف القدرة واسمها العربي ودرجتها وأيقونتها.
2. **Composition Engine**: تركيب قدرات أكثر من نشاط مع إزالة التكرار وإضافة
   الاعتماديات تلقائيًا؛ مثل إضافة `production` التي تحتاج المنتجات وسير العمل.
3. **Business Profile**: ملف نشاط جاهز يختصر الإعداد ويضع نقطة بداية آمنة.
4. **Intelligence Layer**: توصية نشاط قابلة للتفسير من وصف المنشأة، مع إظهار
   نتيجة التوصية بدل تغيير الإعداد بصمت.

ويضم سجل الوحدات الآن وحدات معيارية قابلة للربط بالمسارات عند اكتمال شاشاتها:
المنتجات والخدمات، العملاء، أوامر العمل، الإنتاج، المواعيد، التتبع، والتوصيل.
لا تُضاف وصلة تنقل قبل وجود شاشة حقيقية واختبار عقد لها؛ منع الوصلات الميتة
جزء من معيار الجودة وليس تفصيلًا بصريًا.

يدعم المحرك الآن تركيب أكثر من ملف، مثل:

`retail + tailoring` → منتجات + عملاء + مقاسات + أوامر عمل + إنتاج + حسابات

ويحفظ التكوين محليًا بإصدار تخزين مستقل، لذلك لا تتوقف شاشة البيع عند انقطاع
الخادم. كما أن كل قدرة يمكن لاحقًا أن تسجل:

- مكونات واجهة أو مسارات تظهر عند التفعيل.
- صلاحيات وأدوارًا مطلوبة.
- أحداثًا ومؤشرات تقارير.
- قواعد تحقق وعمليات مزامنة.
- مستوى نضج: أساسية، سير عمل، أو منصة.

### معايير الأدوات الذكية العالمية

أي أداة جديدة في Commerce OS يجب أن تلتزم بالعقد الآتي:

- **Offline-first**: القراءة والكتابة المحلية أولًا، والمزامنة عند الطلب.
- **Explainable**: كل توصية تعرض سببها ومصدرها ودرجة الثقة.
- **Composable**: لا تعتمد على قطاع واحد، بل على قدرات قابلة للتركيب.
- **Permission-aware**: لا تظهر إجراءً لا يملك المستخدم صلاحية تنفيذه.
- **Audit-ready**: كل تغيير في إعدادات النشاط قابل للتتبع والاسترجاع.
- **Touch + keyboard parity**: نفس العملية تعمل باللمس ولوحة المفاتيح والماسح.
- **Arabic-first**: المصطلح العربي هو واجهة المستخدم، والمعرف البرمجي ثابت.
- **Measured**: لكل قدرة معيار أداء واختبار تعاقدي قبل ربطها بالإنتاج.

### مراحل البناء التالية

1. تسجيل القدرات في قائمة تنقل وأذونات موحدة.
2. ربط القدرات بمصادر البيانات المحلية ومخزن المزامنة.
3. إضافة منشئ سير عمل مرئي لأوامر العمل والإنتاج والحجوزات.
4. إضافة Copilot تشغيلي محلي يقترح الإجراء التالي دون إرسال بيانات حساسة.
5. إصدار قوالب قطاعات قابلة للتصدير والاستيراد مع سجل تغييرات.

وأقوى 8 قطاعات أبدأ بها تجاريًا:
الخياطة والملابس → الصيدليات → الورش → الصالونات → المغاسل → الإلكترونيات والجوالات → مواد البناء → الأغذية/المخابز.

لأنها تجمع بين حجم العمليات، تكرار الاستخدام، الحاجة إلى بيانات متخصصة، وفرصة واضحة لتوفير وقت وأخطاء حقيقية. وبالنسبة لبعض القطاعات الخدمية مثل الصالونات والورش والجيم، توجد أيضًا نماذج إيرادات متكررة واشتراكات تجعلها جذابة كمنتج SaaS.
