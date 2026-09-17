# Lelbai WhatsApp Gateway & Bridge Service (بوابة وخادم واتساب منصة للبيع)

خدمة مستقلة مبنية باستخدام **Node.js** و **@whiskeysockets/baileys** لإرسال واستقبال رموز التحقق (OTP) ورسائل الواتساب والتحقق من هوية المستخدمين السوريين والعرب، متصلة بشكل مباشر وآمن مع خادم الاستضافة (Hostinger / Live Server) عبر **جسر API مشفر (API Bridge)**.

---

## 🌟 المميزات (Key Features)

1. **جسر سحابي متكامل (Live Cloud Bridge):**
   - اتصال فوري مع خادم الإنتاج `https://lelbai.com` دون الحاجة لفتح منافذ قاعدة البيانات `3306`.
   - إرسال نبضات دورية (Heartbeat) لمزامنة حالة الاتصال مع لوحة التحكم `Manager`.
   - استهلاك طابور رسائل التحقق (Outbox OTP Queue) وإرسالها فوراً.
   - ترحيل فوري للرسائل الواردة (Inbound Webhooks) للتحقق المباشر من الأرقام السورية `09xxxxxxxx`.

2. **نظام التبديل السلس ورقم الطوارئ (Active-Standby & Auto-Failover):**
   - دعم حفظ عدة جلسات وأرقام هواتف.
   - في حال انقطاع الرقم الأساسي أو حظره، يتحول النظام تلقائياً للرقم الاحتياطي المربوط.

3. **واجهة تحكم ويب مباشرة (Web Dashboard & QR Code):**
   - صفحة ويب تفاعلية على المنفذ `5001` لعرض رمز الاستجابة السريعة (QR Code) ومسحه بالهاتف، وتحديث الحالة تلقائياً.

4. **فحص وجود الرقم على واتساب (Check WhatsApp Number):**
   - فحص الأرقام السورية والعالمية قبل إرسال الرسائل للتأكد من تسجيلها.

---

## 🚀 متطلبات التشغيل (Prerequisites)

- **Node.js** إصدار `18.x` أو أحدث (`v20+` موصى به).
- **npm** أو **pnpm** أو **yarn**.

---

## ⚙️ التثبيت والإعداد (Installation & Setup)

1. **استنساخ المستودع (Clone Repository):**
   ```bash
   git clone https://github.com/moayadalazrk/Lelbai-WhatsApp.git
   cd Lelbai-WhatsApp
   ```

2. **تثبيت الحزم (Install Dependencies):**
   ```bash
   npm install
   ```

3. **إعداد ملف البيئة (.env):**
   انسخ ملف `.env.example` إلى `.env`:
   ```bash
   cp .env.example .env
   ```
   محتوى ملف `.env`:
   ```env
   PORT=5001
   LIVE_BRIDGE_URL=https://lelbai.com/api/bridge/whatsapp
   BRIDGE_SECRET=lelbai_bridge_secure_key_2026_9984
   LOCAL_BACKEND_URL=http://127.0.0.1:8000
   ```

---

## ▶️ تشغيل السيرفر (Running the Service)

### 1. تشغيل مباشر للتطوير:
```bash
npm start
```
أو
```bash
node server.js
```

### 2. تشغيل كخدمة دائمة في الخلفية عبر PM2 (موصى به في السيرفرات / VPS):
```bash
npm install -g pm2
pm2 start server.js --name lelbai-whatsapp
pm2 save
pm2 startup
```

---

## 📱 ربط حساب الواتساب (Scan QR Code)

1. بعد تشغيل الخدمة، افتح المتصفح على:
   ```
   http://localhost:5001
   ```
2. افتح تطبيق واتساب على هاتفك -> **الأجهزة المرتبطة (Linked Devices)** -> **ربط جهاز**.
3. امسح رمز الـ QR الظاهر في الصفحة.
4. ستتحول الحالة إلى **متصل وجاهز للعمل ✅** فوراً، وسيظهر رقم الهاتف في لوحة تحكم `Manager` على السيرفر الحي.

---

## 📡 واجهات البرمجة (API Endpoints)

| المسار (Endpoint) | الطريقة (Method) | الوصف |
| :--- | :--- | :--- |
| `/` | `GET` | واجهة الويب لعرض الـ QR Code والحالة |
| `/health` | `GET` | فحص صحة الخدمة وسرعة الاستجابة |
| `/status` | `GET` | تقرير مفصل بحالة الاتصال والأرقام والجلسات |
| `/sessions` | `GET` | عرض جميع جلسات الأرقام المسجلة |
| `/sessions/create` | `POST` | إضافة رقم احتياطي جديد |
| `/sessions/:id/activate` | `POST` | تفعيل رقم محدد وتشغيله |
| `/check-number` | `POST` | فحص هل الرقم مسجل على واتساب |
| `/send-otp` | `POST` | إرسال رمز تحقق OTP لرقم جوال |

---

## 🛡️ الأمان (Security)
- جميع اتصالات الجسر محمية عبر `X-Bridge-Secret`.
- مجلد `auth_sessions/` مشفر ويحتوي مفاتيح الجلسات ولا يجب رفعه إلى GitHub إطلاقاً (تم استبعاده في `.gitignore`).
