/**
 * Service Worker بسيط ومكتوب يدوياً — بدون أي أداة بناء.
 *
 * يخزّن ملفات التطبيق نفسها (الهيكل الثابت) حتى يفتح التطبيق فوراً وحتى
 * بدون إنترنت. لا يتدخل إطلاقاً في طلبات Firebase/Firestore — تلك يجب
 * أن تصل مباشرة للشبكة دائماً لأنها بيانات حية.
 *
 * استراتيجية التحديث: "اعرض المخزَّن فوراً، وحدّثه في الخلفية"
 * (stale-while-revalidate). هذا يعني أن التطبيق يفتح بسرعة من النسخة
 * المخزَّنة دائماً، وفي نفس الوقت يجلب أي نسخة أحدث من الشبكة بصمت
 * ويحفظها — فتظهر تلقائياً في المرة القادمة التي تُفتح فيها الصفحة،
 * دون الحاجة لتذكّر تغيير رقم النسخة يدوياً بعد كل تعديل.
 *
 * CACHE_VERSION يبقى مفيداً لحالة واحدة فقط: إن غيّرت قائمة الملفات نفسها
 * (أضفت أو حذفت ملفاً من APP_SHELL أدناه)، غيّر الرقم لإجبار حذف الكاش
 * القديم بالكامل والبدء من جديد.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `bond-tracker-${CACHE_VERSION}`;

// كل المسارات نسبية عمداً، حتى يعمل التطبيق من أي مسار فرعي على
// GitHub Pages (مثل username.github.io/repo-name/) دون أي تعديل.
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((path) => new URL(path, self.location).href)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // لا تتدخل أبداً في طلبات Firebase/Google (Firestore, Auth, CDN الخاص
  // بمكتبة Firebase نفسها). يجب أن تذهب دائماً مباشرة للشبكة.
  const isFirebaseOrGoogle =
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebaseapp.com');

  if (isFirebaseOrGoogle || event.request.method !== 'GET') {
    return; // اترك الطلب يذهب للشبكة كالمعتاد
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);

      // نطلب من الشبكة دائماً في الخلفية (سواء وجدنا نسخة مخزَّنة أم لا)،
      // ونحدّث الكاش بصمت لو نجح الطلب — هذا هو جزء "revalidate".
      const networkUpdate = fetch(event.request)
        .then((response) => {
          if (response && response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => null);

      // نُبقي الـ Service Worker حياً حتى يكتمل تحديث الكاش في الخلفية،
      // حتى لو أرجعنا الاستجابة المخزَّنة أدناه قبل أن تنتهي هذه العملية.
      // بدون هذا قد يوقف المتصفح الـ Worker قبل أن يصل التحديث فعلياً.
      event.waitUntil(networkUpdate);

      // "stale": أرجع النسخة المخزَّنة فوراً إن وُجدت، دون انتظار الشبكة.
      if (cached) return cached;

      // لا يوجد كاش بعد (أول مرة لهذا الملف تحديداً) — انتظر الشبكة،
      // وإن فشلت (بلا إنترنت) ولم يوجد بديل، اعرض الصفحة الرئيسية المخزَّنة
      // كحد أدنى حتى لا يفتح التطبيق على صفحة بيضاء.
      const network = await networkUpdate;
      return network || cache.match('./index.html');
    }),
  );
});
