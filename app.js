/**
 * سنداتي — منطق التطبيق بالكامل، بدون أي أداة بناء.
 * كل شيء هنا وحدات ES تُحمَّل مباشرة من المتصفح.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  signInAnonymously,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  collection,
  doc,
  addDoc,
  deleteDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

/* [تعديل الضريبة] بيانات الضريبة التاريخية — المصدر الثابت للمبلغ المستحق. */
import {
  LIVE_TRACKING_FROM,
  OPENING,
  allYearSummaries,
  totalObligation,
} from './tax-data.js';

/* =====================================================================
 * إعدادات Firebase
 * ---------------------------------------------------------------------
 * عبّي القيم التالية من إعدادات مشروعك في Firebase Console:
 * Project settings → General → Your apps → SDK setup and configuration
 * ===================================================================== */
const firebaseConfig = {
  apiKey: 'AIzaSyBobE8lKAbk3RiAemd_NoTMY3avuIjmls0',
  authDomain: 'tax-ead55.firebaseapp.com',
  projectId: 'tax-ead55',
  storageBucket: 'tax-ead55.firebasestorage.app',
  messagingSenderId: '89212945458',
  appId: '1:89212945458:web:6dded1935a102dd600e82b',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// تخزين محلي (IndexedDB) حتى يعمل عرض البيانات وهو غير متصل بالإنترنت.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache(),
});

// مراجع المجموعات تُبنى لاحقاً داخل startListening()، بعد أن نعرف هوية
// المستخدم (uid) — لأن مسار بياناته يعتمد على هذه الهوية تحديداً.
let txCollection;
let priceCollection;
let bondInfoCollection;
let operationsCollection; // [مرحلة 1] أرشيف عمليات تنكوف الدائم
let classificationsCollection; // [مرحلة 3] مجموعة قرارات التصنيف

/* =====================================================================
 * [مرحلة 1] إعدادات المزامنة مع تنكوف (عبر وسيط Vercel)
 * ===================================================================== */
const PROXY_BASE = 'https://tinkoff-vercel.vercel.app';
// تاريخ فتح حساب Future Tax Fund — منه تبدأ المزامنة لتغطية كل التاريخ.
const ACCOUNT_OPENED = '2024-02-01';

/* =====================================================================
 * [مرحلة 3] فئات التصنيف — مرنة: أضف/احذف/عدّل لاحقاً بلا إعادة بناء.
 * التخزين يستخدم id (لا النص)، فتغيير label لا يكسر التصنيفات القديمة.
 * ===================================================================== */
const CLASSIFY_CATEGORIES = {
  deposit: [
    { id: 'tax', label: 'ضريبة' },
    { id: 'investment', label: 'استثمار' },
    { id: 'personal', label: 'تحويل شخصي' },
    { id: 'other_income', label: 'دخل آخر' },
  ],
  withdrawal: [
    { id: 'tax_paid', label: 'دفع ضريبة' },
    { id: 'personal_buy', label: 'شراء شخصي' },
    { id: 'transfer_out', label: 'تحويل لحساب آخر' },
    { id: 'other_reason', label: 'سبب آخر' },
  ],
};
// أنواع تنكوف المفهومة ذاتياً (عمولة 19، ضرائب 5/8/11/13) — لا تُصنّف.
const SELF_EXPLAINED_TYPES = [19, 5, 8, 11, 13];

/* =====================================================================
 * الحالة العامة
 * ===================================================================== */
let transactions = []; // [{ id, type: 'buy'|'sell', symbol, date, qty, price, commission }]
let prices = {}; // { symbol: currentPrice }
let bondInfo = {}; // { symbol: { maturityDate, couponValue, paymentsPerYear } }
let selectedType = 'buy';
let livePositions = []; // [مرحلة 2] المحفظة الحيّة من تنكوف
let archiveOps = [];     // [مرحلة 2] أرشيف العمليات من Firestore
let classifications = {}; // [مرحلة 3] قراراتي (operationId -> قرار)
let filterCategory = 'all'; // [مرحلة 8] فلتر النوع
let filterYear = 'all';     // [مرحلة 8] فلتر السنة

/* =====================================================================
 * أدوات مساعدة للعرض فقط — لا تُغيّر أي رقم، فقط تنسّقه
 * ===================================================================== */
function formatMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('ar', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatQty(n) {
  return new Intl.NumberFormat('ar').format(n);
}

function toneClass(n) {
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'neutral';
}

function showToast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => el.classList.add('hidden'), 2600);
}

/* =====================================================================
 * محرك الحساب — بطريقة متوسط التكلفة (Average Cost)
 * ---------------------------------------------------------------------
 * لكل رمز سند: نمر على عملياته بترتيب التاريخ.
 * عند الشراء: تُضاف الكمية والتكلفة لمتوسط التكلفة الحالي.
 * عند البيع: الربح المحقق = سعر البيع - متوسط التكلفة عند لحظة البيع،
 * مضروباً في الكمية المباعة، مطروحاً منه العمولة.
 * ===================================================================== */
function computeHoldings(txList) {
  const bySymbol = {};

  const sorted = [...txList].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0),
  );

  for (const tx of sorted) {
    if (!bySymbol[tx.symbol]) {
      bySymbol[tx.symbol] = { symbol: tx.symbol, qty: 0, totalCost: 0, realizedPL: 0 };
    }
    const h = bySymbol[tx.symbol];

    if (tx.type === 'buy') {
      h.qty += tx.qty;
      h.totalCost += tx.qty * tx.price + tx.commission;
    } else {
      // بيع: نحسب الربح المحقق بناءً على متوسط التكلفة الحالي، ثم نخفّض
      // الكمية والتكلفة الإجمالية بما يوازي الجزء المباع.
      const avgCost = h.qty > 0 ? h.totalCost / h.qty : 0;
      const soldQty = Math.min(tx.qty, h.qty); // حماية إن كانت البيانات القديمة غير متسقة
      const proceeds = soldQty * tx.price - tx.commission;
      const costOfSold = avgCost * soldQty;
      h.realizedPL += proceeds - costOfSold;
      h.qty -= soldQty;
      h.totalCost -= costOfSold;
    }
  }

  return Object.values(bySymbol);
}

function computeSummary(holdings) {
  let currentValue = 0;
  let totalCost = 0;
  let realizedPL = 0;

  for (const h of holdings) {
    realizedPL += h.realizedPL;
    if (h.qty > 0.0001) {
      const price = prices[h.symbol] ?? h.totalCost / h.qty; // نستخدم متوسط التكلفة كتقدير احتياطي إن لم يُدخل المستخدم سعراً
      currentValue += h.qty * price;
      totalCost += h.totalCost;
    }
  }

  const unrealizedPL = currentValue - totalCost;

  return { currentValue, totalCost, unrealizedPL, realizedPL };
}

/* =====================================================================
 * قدرة بيع متاحة لكل رمز — تُستخدم للتحقق قبل تسجيل عملية بيع
 * ===================================================================== */
function availableQtyFor(symbol) {
  const holdings = computeHoldings(transactions);
  const h = holdings.find((x) => x.symbol === symbol);
  return h ? h.qty : 0;
}

/* =====================================================================
 * العرض — الملخص
 * ===================================================================== */
function renderAll() {
  renderSummary();
  renderHoldings();
  renderTransactions();
  renderTaxFund();
  renderAnalytics();
  renderAlerts();
  populateYearFilter();
  renderReport();
}

// [تعديل] الربح المحقق من الأرشيف (متوسط تكلفة، بلا عمولات).
// يشمل ثلاثة مصادر: فرق البيع، فرق الاستحقاق، والكوبونات.
function computeRealizedFromArchive() {
  const byFigi = {};
  const sorted = [...archiveOps]
    .filter((o) => o.figi && ['buy', 'sell', 'redemption'].includes(o.category))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  let realized = 0;
  for (const o of sorted) {
    const h = byFigi[o.figi] || (byFigi[o.figi] = { qty: 0, cost: 0 });
    if (o.category === 'buy') {
      h.qty += o.quantity || 0;
      h.cost += Math.abs(o.payment || 0);
    } else {
      // بيع أو استحقاق: الربح = المقبوض − تكلفة الكمية الخارجة.
      // في الاستحقاق قد لا تُرجع تنكوف كمية، فنأخذ كامل المركز المتبقي.
      const avg = h.qty > 0 ? h.cost / h.qty : 0;
      const raw = o.quantity || 0;
      const outQty = o.category === 'redemption' && raw <= 0 ? h.qty : Math.min(raw, h.qty);
      realized += (o.payment || 0) - avg * outQty;
      h.qty -= outQty;
      h.cost -= avg * outQty;
    }
  }
  // + كل الكوبونات المستلمة.
  const coupons = archiveOps.reduce((sum, o) => sum + (o.category === 'coupon' ? (o.payment || 0) : 0), 0);
  return realized + coupons;
}

// [مرحلة 2] جلب المحفظة الحيّة من تنكوف.
async function loadPortfolio() {
  let data;
  try {
    data = await callProxy('/api/portfolio');
  } catch (err) {
    showToast('تعذّر جلب المحفظة: ' + err.message, true);
    return;
  }
  livePositions = data.positions || [];
  renderAll();
}

// [تعديل الواجهة] بطاقة الملخص — أربعة أرقام.
function renderSummary() {
  // 1) قيمة المحفظة = كل الأوراق المالية بالسعر الحالي + النقد.
  let securitiesValue = 0;
  let cash = 0;
  for (const p of livePositions) {
    const qty = p.quantity || 0;
    const price = (p.currentPrice != null ? p.currentPrice : p.averagePositionPrice) || 0;
    if (p.instrumentType === 'currency') cash += qty * price;
    else securitiesValue += qty * price;
  }
  const portfolioValue = securitiesValue + cash;

  // 2) الربح المحقق = فرق البيع/الشراء + الكوبونات المستلمة.
  //    (الدالة تضيف الكوبونات داخلها — لا تُضاف هنا مرة ثانية.)
  const realized = computeRealizedFromArchive();

  // 3) الربح المتوقع حتى الاستحقاق = عائد رأس المال + الكوبونات المتبقية.
  const expected = expectedReturnToMaturity().total;

  // 4) نسبة الربح من رأس المال المودع = الربح المحقق ÷ مجموع الإيداعات.
  const deposits = archiveOps.reduce(
    (sum, o) => sum + (o.category === 'deposit' ? (o.payment || 0) : 0),
    0,
  );
  const pct = deposits > 0 ? (realized / deposits) * 100 : null;

  setMetric('sumPortfolioValue', formatMoney(portfolioValue), 'neutral');
  setMetric('sumRealized', formatMoney(realized), toneClass(realized));
  setMetric('sumExpected', formatMoney(expected), toneClass(expected));
  setMetric('sumReturnPct', pct == null ? '—' : `${pct.toFixed(2)}%`, pct == null ? 'neutral' : toneClass(pct));
}

function setMetric(id, text, tone) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `value tabular ${tone}`;
}

/* =====================================================================
 * العرض — السندات الحالية
 * ===================================================================== */
function renderHoldings() {
  const container = document.getElementById('holdingsList');
  const bonds = livePositions.filter((p) => p.instrumentType === 'bond' && (p.quantity || 0) > 0.0001);

  if (bonds.length === 0) {
    container.innerHTML = '<p class="empty">لا توجد سندات مملوكة حالياً</p>';
    return;
  }

  container.innerHTML = bonds
    .map((p) => {
      const qty = p.quantity || 0;
      const avgCost = p.averagePositionPrice || 0;
      const price = (p.currentPrice != null ? p.currentPrice : avgCost) || 0;
      const value = qty * price;
      const cost = qty * avgCost;
      const pl = value - cost;
      const pct = cost > 0 ? (pl / cost) * 100 : 0;

      // التغير تراكمي منذ الشراء (وليس يومياً): السعر الحالي مقابل متوسط
      // تكلفتك. يتراكم عبر الأيام — يومان بـ‏−1٪ يظهران ‏−2٪.
      const chg = pl;
      const chgPct = pct;
      const up = chg >= 0;
      const tone = up ? 'positive' : 'negative';
      const title = p.name || p.ticker || p.figi || '—';
      return `
        <div class="bond-card" data-figi="${escapeHtml(String(p.figi || ''))}">
          <div class="bond-name">${escapeHtml(title)}</div>
          <div class="bond-value tabular">${formatMoney(value)} ₽</div>
          <div class="bond-sub">
            <span>الكمية: ${formatQty(qty)}</span>
          </div>
          <div class="bond-change ${tone} tabular">
            <span class="bond-arrow">${up ? '▲' : '▼'}</span>
            ${up ? '+' : '−'}${formatMoney(Math.abs(chg))} ₽
            <span class="bond-pct">(${up ? '+' : '−'}${Math.abs(chgPct).toFixed(2)}%)</span>
            <span class="bond-chg-label">منذ الشراء</span>
          </div>
        </div>`;
    })
    .join('');
}

// [تعديل الواجهة] نافذة تفاصيل السند — عرض فقط، تقرأ من نفس بيانات المحفظة.
function openBondModal(figi) {
  const p = livePositions.find((x) => String(x.figi) === String(figi));
  if (!p) return;
  const qty = p.quantity || 0;
  const avgCost = p.averagePositionPrice || 0;
  const price = (p.currentPrice != null ? p.currentPrice : avgCost) || 0;
  const info = bondInfo[p.ticker] || {};
  const coupons = p.couponQuantityPerYear ?? info.paymentsPerYear ?? null;
  const maturity = p.maturityDate
    ? String(p.maturityDate).slice(0, 10)
    : (info.maturityDate || null);

  const rows = [
    ['عدد الكوبونات السنوية', coupons != null ? `${coupons}` : '—'],
    ['تاريخ الاستحقاق', maturity || '—'],
    ['الكمية', formatQty(qty)],
    ['متوسط سعر الشراء', `${formatMoney(avgCost)} ₽`],
    ['السعر الحالي', `${formatMoney(price)} ₽`],
  ];

  document.getElementById('bondModalTitle').textContent = p.name || p.ticker || p.figi || '—';
  document.getElementById('bondModalBody').innerHTML = rows
    .map(([k, v]) => `<div class="bond-detail-row"><span>${k}</span><span class="tabular">${escapeHtml(v)}</span></div>`)
    .join('');
  document.getElementById('bondModal').classList.remove('hidden');
}

function closeBondModal() {
  document.getElementById('bondModal').classList.add('hidden');
}

document.addEventListener('click', (e) => {
  const card = e.target.closest('.bond-card');
  if (card) { openBondModal(card.dataset.figi); return; }
  const modal = document.getElementById('bondModal');
  if (modal && !modal.classList.contains('hidden')) {
    if (e.target.id === 'bondModalClose' || e.target === modal) closeBondModal();
  }
});

/* [تنظيف] حُذفت هنا خمس دوال ميّتة كانت تتصل بـ iss.moex.com مباشرة:
 * fetchMoexBondInfo · saveMoexBondInfoIfFound · fetchMoexPrice
 * saveMoexPriceIfFound · onPriceChange
 * لم تكن مستدعاة من أي مكان. كل بياناتها يوفّرها تنكوف عبر الوسيط.
 * اشتراكات Firestore (prices / bondInfo) بقيت كما هي للقراءة فقط. */


/* =====================================================================
 * العرض — سجل العمليات
 * ===================================================================== */
function renderTransactions() {
  const container = document.getElementById('txList');
  const CAT = { buy: 'شراء', sell: 'بيع', coupon: 'كوبون', redemption: 'استحقاق', deposit: 'إيداع', withdrawal: 'سحب' };

  const rows = archiveOps.filter((o) => {
    if (!CAT[o.category]) return false;
    if (filterCategory !== 'all' && o.category !== filterCategory) return false;
    if (filterYear !== 'all' && String(o.date || '').slice(0, 4) !== filterYear) return false;
    return true;
  });
  if (rows.length === 0) {
    container.innerHTML = '<p class="empty">لا توجد عمليات بعد</p>';
    return;
  }

  const sorted = [...rows].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  container.innerHTML = sorted
    .map((o) => {
      const label = CAT[o.category];
      const pay = o.payment || 0;
      const badgeClass = pay >= 0 ? 'buy' : 'sell';
      const title = o.figi || label;
      const qtyPart = o.quantity ? formatQty(o.quantity) + ' وحدة · ' : '';
      return `
        <div class="tx-row">
          <span class="tx-badge ${badgeClass}">${label}</span>
          <div class="tx-main">
            <div class="tx-symbol">${escapeHtml(title)}</div>
            <div class="tx-details">${String(o.date || '').slice(0, 10)} · ${qtyPart}${formatMoney(Math.abs(pay))} ₽</div>
          </div>
          <div style="text-align:left;">
            <div class="tx-amount tabular ${toneClass(pay)}">${pay >= 0 ? '+' : '−'}${formatMoney(Math.abs(pay))}</div>
          </div>
        </div>`;
    })
    .join('');
}

async function onDeleteTransaction(e) {
  const id = e.currentTarget.dataset.deleteId;
  if (!confirm('حذف هذه العملية نهائياً؟')) return;
  try {
    await deleteDoc(doc(txCollection, id));
    showToast('تم الحذف');
  } catch (err) {
    showToast('تعذّر الحذف: ' + err.message, true);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

/* =====================================================================
 * التنقل بين الصفحتين
 * ===================================================================== */
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === btn.dataset.target));
  });
});

/* =====================================================================
 * Firebase — تسجيل دخول مجهول تلقائي + الاستماع الحي للبيانات
 * ---------------------------------------------------------------------
 * لا توجد شاشة تسجيل دخول: يتم تسجيل الدخول تلقائياً وبصمت. البيانات
 * تُخزَّن تحت مسار خاص بهوية هذا المستخدم المجهول فقط (users/{uid}/…)،
 * وقواعد Firestore (firestore.rules) تتحقق أن request.auth.uid يطابق
 * uid المسار قبل السماح بأي قراءة أو كتابة. هذا هو ما يمنع أي زائر آخر
 * من رؤية بياناتك أو تعديلها، وليس مجرد كونه "مسجّل دخول" بشكل عام —
 * فأي شخص يفتح نفس الرابط سيُسجَّل دخوله تلقائياً أيضاً، لكن بهوية
 * مختلفة تماماً لا تصل إلى مسارك أنت.
 *
 * setPersistence(browserLocalPersistence) يضمن أن نفس الهوية المجهولة
 * تُستعاد من تخزين المتصفح في كل مرة تُفتح فيها الصفحة على نفس الجهاز —
 * فلا تُفقد بياناتك عند إغلاق التطبيق وإعادة فتحه من الشاشة الرئيسية.
 * ===================================================================== */
/* =====================================================================
 * [مرحلة 1] طبقة المزامنة — جلب عمليات تنكوف وتخزينها في Firestore
 * ---------------------------------------------------------------------
 * أرشيف دائم: الجديد يُضاف، المتغيّر يُحدَّث (بمعرّف العملية)، ولا يُحذف
 * شيء أبداً. هذه الطبقة لا تلمس العرض بعد.
 * ===================================================================== */
function monthsSinceOpen() {
  const open = new Date(ACCOUNT_OPENED);
  const now = new Date();
  const months = (now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth());
  return Math.min(months + 2, 60);
}

async function callProxy(path) {
  if (!auth.currentUser) throw new Error('لم تكتمل المصادقة بعد');
  const token = await auth.currentUser.getIdToken();
  let res;
  try {
    res = await fetch(PROXY_BASE + path, { headers: { Authorization: 'Bearer ' + token } });
  } catch {
    throw new Error('تعذّر الاتصال بالوسيط (تحقق من الإنترنت أو الإعدادات)');
  }
  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try { const b = await res.json(); if (b && b.error) detail = b.error; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// المزامنة: كل العمليات من فتح الحساب، تُخزَّن دمجاً بلا حذف.
async function syncOperations() {
  if (!operationsCollection) return;
  let data;
  try {
    data = await callProxy('/api/operations?monthsBack=' + monthsSinceOpen());
  } catch (err) {
    showToast('تعذّرت المزامنة: ' + err.message, true);
    return;
  }
  const ops = data.operations || [];
  try {
    let batch = writeBatch(db);
    let n = 0;
    for (const op of ops) {
      batch.set(
        doc(operationsCollection, String(op.id)),
        { ...op, syncedAt: serverTimestamp() },
        { merge: true },
      );
      n++;
      if (n % 450 === 0) { await batch.commit(); batch = writeBatch(db); }
    }
    await batch.commit();
    showToast('تمت مزامنة ' + ops.length + ' عملية');
    console.log('[مزامنة] العمليات المخزّنة:', ops.length, '| الحساب:', data.accountId);
  } catch (err) {
    showToast('تعذّر حفظ الأرشيف: ' + err.message, true);
  }
}

/* =====================================================================
 * [مرحلة 3 · 1/5] طبقة بيانات التصنيف — قراءة فقط (بلا حفظ ولا واجهة)
 * ---------------------------------------------------------------------
 * قاعدة موحّدة: نتجاهل اسم العملية وننظر لتأثيرها على الرصيد.
 *   موجبة وليست (شراء/بيع/كوبون/استحقاق/عمولة/ضريبة) ⇒ إيداع يحتاج تصنيف.
 *   سالبة بنفس الاستثناءات ⇒ سحب يحتاج تصنيف.
 * ===================================================================== */
function needsClassification(op) {
  const pay = op.payment || 0;
  if (pay === 0) return false;
  // [تعديل الضريبة] قفل التاريخ: كل ما قبل نقطة البداية محسوم في tax-data.js
  // ولا يُسأل عنه إطلاقاً. هذا ما يمنع انتفاخ الرقم من سنوات سابقة.
  if (String(op.date || '') < LIVE_TRACKING_FROM) return false;
  if (['buy', 'sell', 'coupon', 'redemption'].includes(op.category)) return false;
  if (SELF_EXPLAINED_TYPES.includes(op.typeRaw)) return false;
  return true; // حركة نقدية تحتاج تصنيفاً
}

function opKind(op) {
  return (op.payment || 0) > 0 ? 'deposit' : 'withdrawal';
}

// العمليات غير المصنّفة = تحتاج تصنيفاً وليست موجودة في classifications.
function getUnclassifiedOps() {
  return archiveOps
    .filter((o) => needsClassification(o) && !classifications[String(o.id)])
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

// [مرحلة 3 · 2/5] حفظ قرارات التصنيف — المفتاح = معرّف العملية (بلا تكرار).
// كل قرار يُكتب بالكامل، فإعادة التصنيف لاحقاً تستبدل القديم (مرونة التعديل).
async function saveClassifications(decisions) {
  if (!classificationsCollection || !decisions || !decisions.length) return;
  const batch = writeBatch(db);
  for (const d of decisions) {
    batch.set(doc(classificationsCollection, String(d.operationId)), {
      operationId: String(d.operationId),
      kind: d.kind,           // 'deposit' | 'withdrawal'
      categoryId: d.categoryId, // id الفئة (لا النص)
      decidedAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

/* =====================================================================
 * [مرحلة 4 · 1/2] دورة الضريبة — منطق داخلي فقط (يُحسب عند الطلب، بلا تخزين)
 * ---------------------------------------------------------------------
 * يقرأ من الأرشيف + قراراتي (classifications) دون تخزين أي قيمة مشتقّة.
 *   مموّل  = مجموع الإيداعات المصنّفة 'tax'.
 *   مدفوع = مجموع السحوبات المصنّفة 'tax_paid' (بالقيمة المطلقة).
 *   الرصيد = مموّل − مدفوع.
 * ===================================================================== */
/* =====================================================================
 * [تعديل الضريبة] دورة الضريبة — أربعة أرقام بدل ثلاثة
 * ---------------------------------------------------------------------
 *   المستحق = من tax-data.js (ثابت، لا يُحسب من تنكوف أبداً).
 *   المموّل  = رصيد افتتاحي + إيداعات 'tax' بعد نقطة البداية فقط.
 *   المدفوع = مدفوعات السنوات السابقة + سحوبات 'tax_paid' بعد نقطة البداية.
 *   الناقص  = المستحق − المدفوع − المموّل.
 *
 * ملاحظة مهمة: كل جمع هنا يتجاهل ما قبل LIVE_TRACKING_FROM، حتى لو بقيت
 * تصنيفات قديمة محفوظة في Firestore — فلا يتكرر انتفاخ الرقم.
 * ===================================================================== */
function afterCutoff(o) {
  return String(o.date || '') >= LIVE_TRACKING_FROM;
}

/** إجمالي الضريبة المستحقة عليك عبر كل السنوات. */
function getTaxDue() {
  return totalObligation();
}

/** مموّل: مرصود في الحساب ولم يُدفع بعد. */
function getTaxFunded() {
  const opening = Number(OPENING.fundedNow) || 0;
  return archiveOps.reduce((sum, o) => {
    if (!afterCutoff(o)) return sum;
    const c = classifications[String(o.id)];
    if (c && c.kind === 'deposit' && c.categoryId === 'tax') return sum + (o.payment || 0);
    return sum;
  }, opening);
}

/** مدفوع: خرج فعلاً لمصلحة الضرائب. */
function getTaxPaid() {
  const live = new Set((OPENING.paidCountedLive || []).map(String));
  const opening = Object.entries(OPENING.paidSoFar)
    .filter(([y]) => !live.has(String(y)))   // ما دُفع بعد نقطة البداية يأتي من العمليات
    .reduce((s, [, v]) => s + (Number(v) || 0), 0);
  return archiveOps.reduce((sum, o) => {
    if (!afterCutoff(o)) return sum;
    const c = classifications[String(o.id)];
    if (c && c.kind === 'withdrawal' && c.categoryId === 'tax_paid') return sum + Math.abs(o.payment || 0);
    return sum;
  }, opening);
}

/**
 * المستحق للدفع = مجموع ضرائب السنوات **غير المسدّدة** فقط.
 * السنة المقفلة لا تترك بقايا كسور، فلا يظهر رقم مثل 117,000.80.
 */
function getTaxOwed() {
  return allYearSummaries()
    .filter((y) => !y.settled)
    .reduce((s, y) => s + y.tax, 0);
}

/* =====================================================================
 * [مرحلة 10 · 1/3] منطق التنبيهات الذكية — يُحسب عند الطلب من البيانات الجاهزة.
 * ===================================================================== */
function getAlerts() {
  const alerts = [];
  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 86400000);
  // 1) سندات تقترب من الاستحقاق (خلال 30 يوماً)
  for (const p of livePositions) {
    if (p.instrumentType === 'bond' && p.quantity > 0 && p.maturityDate) {
      const md = new Date(p.maturityDate);
      if (md >= now && md <= soon) {
        const days = Math.ceil((md - now) / 86400000);
        alerts.push({
          icon: '⏰',
          text: (p.ticker || p.name || p.figi) + ' يستحق خلال ' + days + ' يوماً (' + String(p.maturityDate).slice(0, 10) + ')',
        });
      }
    }
  }
  // 2) عمليات بانتظار التصنيف
  const un = getUnclassifiedOps().length;
  if (un > 0) alerts.push({ icon: '🏷️', text: un + ' عملية بانتظار التصنيف' });
  // 3) حالة صندوق الضريبة
  const gap = getTaxOwed() - getTaxFunded();
  if (gap > 1) {
    alerts.push({ icon: '⚠️', text: 'ينقصك ' + formatMoney(gap) + ' ₽ لتغطية الضريبة المستحقة' });
  } else {
    const funded = getTaxFunded();
    if (funded > 0) alerts.push({ icon: '✅', text: 'الضريبة مغطّاة بالكامل — مرصود ' + formatMoney(funded) + ' ₽ لم يُدفع بعد' });
  }
  return alerts;
}

// [مرحلة 10 · 2/3] عرض التنبيهات في بطاقتها.
function renderAlerts() {
  const el = document.getElementById('alertsList');
  if (!el) return;
  const alerts = getAlerts();
  if (!alerts.length) { el.innerHTML = '<p class="empty">لا تنبيهات حالياً</p>'; return; }
  el.innerHTML = alerts.map((a) => `<div class="holding-qty">${a.icon} ${escapeHtml(a.text)}</div>`).join('');
}

// [تعديل الضريبة] عرض صندوق الضريبة — أربع خانات.
function renderTaxFund() {
  const owed = getTaxOwed();
  setMetric('taxDue', formatMoney(getTaxDue()), 'neutral');
  setMetric('taxPaid', formatMoney(getTaxPaid()), 'neutral');
  setMetric('taxFunded', formatMoney(getTaxFunded()), 'neutral');
  setMetric('taxOwed', formatMoney(owed), owed > getTaxFunded() ? 'negative' : 'neutral');
  renderTaxYears();
}

// [تعديل الواجهة] صياغة عدد الأشهر بالعربية الفصيحة.
function monthsLabel(n) {
  if (n === 0) return 'لا أشهر';
  if (n === 1) return 'شهر واحد';
  if (n === 2) return 'شهران';
  if (n <= 10) return `${n} أشهر`;
  return `${n} شهراً`;
}

// [تعديل الضريبة] الملخص السنوي — للعرض فقط، من tax-data.js.
function renderTaxYears() {
  const el = document.getElementById('taxYearsList');
  if (!el) return;
  const paid = OPENING.paidSoFar || {};
  el.innerHTML = allYearSummaries()
    .map((y) => {
      const done = y.settled; // نفس قاعدة التسوية المستخدمة في الحساب
      return `<div class="tax-year-row">
        <div class="tax-year-main">
          <div class="tax-year-num">${y.year}</div>
          <div class="tax-year-salary">الراتب السنوي - ${formatMoney(y.salary)} ₽</div>
        </div>
        <div class="tax-year-side">
          <div class="tax-year-due tabular">${done ? '✅' : '⏳'} ${formatMoney(y.tax)} ₽</div>
          <div class="tax-year-months">${monthsLabel(y.months)}</div>
        </div>
      </div>`;
    })
    .join('');
}

/* =====================================================================
 * [مرحلة 7 · 1/4] طبقة التحليلات — دوال تُحسب عند الطلب من الأرشيف، بلا تخزين.
 * ===================================================================== */
// دخل الكوبونات (متضمّناً التوزيعات المضمومة) لكل سنة.
function incomeByYear() {
  const m = {};
  for (const o of archiveOps) {
    if (o.category === 'coupon' && o.date) {
      const y = String(o.date).slice(0, 4);
      m[y] = (m[y] || 0) + (o.payment || 0);
    }
  }
  return m;
}

// دخل الكوبونات لكل شهر (YYYY-MM).
function incomeByMonth() {
  const m = {};
  for (const o of archiveOps) {
    if (o.category === 'coupon' && o.date) {
      const ym = String(o.date).slice(0, 7);
      m[ym] = (m[ym] || 0) + (o.payment || 0);
    }
  }
  return m;
}

// رأس المال العائد من الاستحقاقات لكل سنة.
function redemptionsByYear() {
  const m = {};
  for (const o of archiveOps) {
    if (o.category === 'redemption' && o.date) {
      const y = String(o.date).slice(0, 4);
      m[y] = (m[y] || 0) + (o.payment || 0);
    }
  }
  return m;
}

// الربح المحقق لكل سند (figi) — متوسط تكلفة من الأرشيف.
function realizedProfitByBond() {
  const holdings = {};
  const result = {};
  const sorted = [...archiveOps]
    .filter((o) => o.figi && (o.category === 'buy' || o.category === 'sell'))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  for (const o of sorted) {
    const h = holdings[o.figi] || (holdings[o.figi] = { qty: 0, cost: 0 });
    if (o.category === 'buy') {
      h.qty += o.quantity || 0;
      h.cost += Math.abs(o.payment || 0);
    } else {
      const avg = h.qty > 0 ? h.cost / h.qty : 0;
      const soldQty = Math.min(o.quantity || 0, h.qty);
      result[o.figi] = (result[o.figi] || 0) + ((o.payment || 0) - avg * soldQty);
      h.qty -= soldQty;
      h.cost -= avg * soldQty;
    }
  }
  return result;
}

/* =====================================================================
 * [مرحلة 9 · 1/3] العائد المتوقع حتى الاستحقاق (من المحفظة الحيّة + الأرشيف)
 * ---------------------------------------------------------------------
 *  عائد رأس المال = (الاسمي − السعر الحالي) × الكمية  (دقيق، سحب نحو القيمة الاسمية).
 *  الكوبونات المتبقية = كوبونات آخر 12 شهراً لهذا السند × سنوات حتى الاستحقاق (تقديري).
 * ===================================================================== */
function couponsLast12mByFigi() {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const m = {};
  for (const o of archiveOps) {
    if (o.category === 'coupon' && o.figi && o.date && new Date(o.date) >= cutoff) {
      m[o.figi] = (m[o.figi] || 0) + (o.payment || 0);
    }
  }
  return m;
}

function expectedReturnToMaturity() {
  const recent = couponsLast12mByFigi();
  const now = new Date();
  const rows = [];
  let totalCapital = 0;
  let totalCoupons = 0;
  for (const p of livePositions) {
    if (p.instrumentType !== 'bond' || !(p.quantity > 0) || !p.maturityDate) continue;
    const qty = p.quantity;
    const nominal = p.nominal || 0;
    const price = p.currentPrice != null ? p.currentPrice : (p.averagePositionPrice || 0);
    const capital = (nominal - price) * qty;
    const years = Math.max((new Date(p.maturityDate) - now) / (365.25 * 86400000), 0);
    const coupons = (recent[p.figi] || 0) * years;
    totalCapital += capital;
    totalCoupons += coupons;
    rows.push({
      title: p.ticker || p.name || p.figi,
      maturity: String(p.maturityDate).slice(0, 10),
      capital,
      coupons,
      total: capital + coupons,
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return { rows, totalCapital, totalCoupons, total: totalCapital + totalCoupons };
}

// [مرحلة 7 · 3/4] عرض التحليلات (يعيد استخدام أنماط الصفوف الموجودة).
function renderRows(containerId, entries, fmt) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!entries.length) { el.innerHTML = '<p class="empty">لا توجد بيانات</p>'; return; }
  el.innerHTML = entries
    .map(([k, v]) => `
      <div class="holding-row">
        <div class="holding-top">
          <div class="holding-symbol">${escapeHtml(String(k))}</div>
          <div class="holding-value"><div class="amount tabular ${v >= 0 ? 'positive' : 'negative'}">${fmt(v)}</div></div>
        </div>
      </div>`)
    .join('');
}

function renderAnalytics() {
  const money = (v) => formatMoney(v) + ' ₽';
  const signed = (v) => (v >= 0 ? '+' : '') + formatMoney(v) + ' ₽';
  renderRows('analyticsIncomeYear', Object.entries(incomeByYear()).sort((a, b) => b[0].localeCompare(a[0])), money);
  renderRows('analyticsRedemptions', Object.entries(redemptionsByYear()).sort((a, b) => b[0].localeCompare(a[0])), money);
  renderRows('analyticsProfitBond', Object.entries(realizedProfitByBond()).sort((a, b) => b[1] - a[1]), signed);
  renderRows('analyticsIncomeMonth', Object.entries(incomeByMonth()).sort((a, b) => b[0].localeCompare(a[0])), money);
  renderExpectedReturn();
}

// [مرحلة 9 · 2/3] عرض العائد المتوقع حتى الاستحقاق.
function renderExpectedReturn() {
  const r = expectedReturnToMaturity();
  setMetric('ermCapital', formatMoney(r.totalCapital), r.totalCapital >= 0 ? 'positive' : 'negative');
  setMetric('ermCoupons', formatMoney(r.totalCoupons), 'neutral');
  setMetric('ermTotal', formatMoney(r.total), r.total >= 0 ? 'positive' : 'negative');
  const el = document.getElementById('ermList');
  if (!el) return;
  if (!r.rows.length) { el.innerHTML = '<p class="empty">لا توجد سندات</p>'; return; }
  el.innerHTML = r.rows
    .map((b) => `
      <div class="holding-row">
        <div class="holding-top">
          <div>
            <div class="holding-symbol">${escapeHtml(b.title)}</div>
            <div class="holding-qty">الاستحقاق: ${b.maturity}</div>
          </div>
          <div class="holding-value"><div class="amount tabular ${b.total >= 0 ? 'positive' : 'negative'}">${b.total >= 0 ? '+' : ''}${formatMoney(b.total)} ₽</div></div>
        </div>
      </div>`)
    .join('');
}

/* =====================================================================
 * [مرحلة 3 · 3/5] النافذة المنبثقة للتصنيف
 * ===================================================================== */
const promptedOpIds = new Set(); // [مرحلة 4] عمليات عُرضت في نافذة هذه الجلسة
let archiveLoaded = false;
let classificationsLoaded = false;

function renderClassifyModal(ops) {
  const list = document.getElementById('classifyList');
  list.innerHTML = ops
    .map((o) => {
      const kind = opKind(o);
      const label = kind === 'deposit' ? 'إيداع' : 'سحب';
      const options = CLASSIFY_CATEGORIES[kind]
        .map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`)
        .join('');
      return `
        <div class="classify-row" data-op-id="${escapeHtml(String(o.id))}" data-kind="${kind}">
          <div class="classify-info">
            <div class="classify-amount ${kind === 'deposit' ? 'positive' : 'negative'}">${label} ${formatMoney(Math.abs(o.payment || 0))} ₽</div>
            <div class="classify-date">${String(o.date || '').slice(0, 10)}</div>
          </div>
          <select class="classify-select">${options}</select>
        </div>`;
    })
    .join('');
}

function openClassifyModal(ops) {
  if (!ops || !ops.length) return;
  renderClassifyModal(ops);
  document.getElementById('classifyModal').classList.remove('hidden');
}

function closeClassifyModal() {
  document.getElementById('classifyModal').classList.add('hidden');
}

// يفتح النافذة مرة واحدة عند وجود عمليات غير مصنّفة (الدفعة القديمة).
function maybePromptClassify() {
  if (!archiveLoaded || !classificationsLoaded) return;
  const modal = document.getElementById('classifyModal');
  if (modal && !modal.classList.contains('hidden')) return; // النافذة مفتوحة — لا نقاطع
  // الجديد فقط: غير مصنّف ولم يُعرض في هذه الجلسة.
  const pending = getUnclassifiedOps().filter((o) => !promptedOpIds.has(String(o.id)));
  if (pending.length === 0) return;
  pending.forEach((o) => promptedOpIds.add(String(o.id)));
  openClassifyModal(pending);
}

document.getElementById('classifyLaterBtn')?.addEventListener('click', closeClassifyModal);
document.getElementById('classifySaveBtn')?.addEventListener('click', async () => {
  const rows = [...document.querySelectorAll('.classify-row')];
  const decisions = rows.map((r) => ({
    operationId: r.dataset.opId,
    kind: r.dataset.kind,
    categoryId: r.querySelector('.classify-select').value,
  }));
  const btn = document.getElementById('classifySaveBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الحفظ…';
  try {
    await saveClassifications(decisions);
    showToast('تم حفظ ' + decisions.length + ' تصنيفاً');
    closeClassifyModal();
  } catch (err) {
    showToast('تعذّر الحفظ: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'حفظ الكل';
  }
});

/* =====================================================================
 * [مرحلة 8 · 1/3] الفلاتر — تعبئة السنوات + ربط عناصر التحكم
 * ===================================================================== */
function populateYearFilter() {
  const sel = document.getElementById('filterYear');
  if (!sel) return;
  const years = [...new Set(archiveOps.map((o) => String(o.date || '').slice(0, 4)).filter(Boolean))]
    .sort()
    .reverse();
  const current = sel.value;
  sel.innerHTML =
    '<option value="all">كل السنوات</option>' +
    years.map((y) => `<option value="${y}">${y}</option>`).join('');
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
}

// [مرحلة 8 · 2/3] تقرير مختصر للسنة المختارة (أو الكل).
function renderReport() {
  const el = document.getElementById('reportSummary');
  if (!el) return;
  const inYear = (o) => filterYear === 'all' || String(o.date || '').slice(0, 4) === filterYear;
  let coupons = 0, redemptions = 0, deposits = 0, withdrawals = 0;
  for (const o of archiveOps) {
    if (!inYear(o)) continue;
    const pay = o.payment || 0;
    if (o.category === 'coupon') coupons += pay;
    else if (o.category === 'redemption') redemptions += pay;
    else if (o.category === 'deposit') deposits += pay;
    else if (o.category === 'withdrawal') withdrawals += Math.abs(pay);
  }
  const title = filterYear === 'all' ? 'كل السنوات' : 'سنة ' + filterYear;
  el.innerHTML =
    `<div class="holding-qty">تقرير ${title}:</div>` +
    `<div class="holding-qty">كوبونات: ${formatMoney(coupons)} · استحقاقات: ${formatMoney(redemptions)}</div>` +
    `<div class="holding-qty">إيداعات: ${formatMoney(deposits)} · سحوبات: ${formatMoney(withdrawals)}</div>`;
}

document.getElementById('filterCategory')?.addEventListener('change', (e) => {
  filterCategory = e.target.value;
  renderTransactions();
  renderReport();
});
document.getElementById('filterYear')?.addEventListener('change', (e) => {
  filterYear = e.target.value;
  renderTransactions();
  renderReport();
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    startListening(user.uid);
  }
});

setPersistence(auth, browserLocalPersistence)
  .catch(() => {
    /* فشل نادر جداً — الجلسة تستمر بالسلوك الافتراضي دون توقف التطبيق */
  })
  .finally(() => {
    signInAnonymously(auth).catch((err) => {
      showToast('تعذّر الاتصال بقاعدة البيانات: ' + err.message, true);
    });
  });

let listenersStarted = false;
function startListening(uid) {
  if (listenersStarted) return;
  listenersStarted = true;

  const userDataPath = `users/${uid}/bondTracker`;
  txCollection = collection(db, userDataPath, 'data', 'transactions');
  priceCollection = collection(db, userDataPath, 'data', 'prices');
  bondInfoCollection = collection(db, userDataPath, 'data', 'bondInfo');
  operationsCollection = collection(db, userDataPath, 'data', 'operations');
  classificationsCollection = collection(db, userDataPath, 'data', 'classifications');

  // [مرحلة 3 · 1/5] قراءة قراراتي (لا تُمسّ بالمزامنة أبداً).
  onSnapshot(
    classificationsCollection,
    (snap) => {
      classifications = {};
      snap.docs.forEach((d) => {
        classifications[d.id] = d.data();
      });
      classificationsLoaded = true;
      renderAll();
      console.log('[تصنيف] محفوظة:', snap.size, '| تحتاج تصنيف الآن:', getUnclassifiedOps().length);
      maybePromptClassify();
    },
    (err) => showToast('خطأ في قراءة التصنيفات: ' + err.message, true),
  );

  // [مرحلة 2] الاستماع للأرشيف + جلب المحفظة الحيّة + مزامنة.
  onSnapshot(
    operationsCollection,
    (snap) => {
      archiveOps = snap.docs.map((d) => d.data());
      archiveLoaded = true;
      renderAll();
      maybePromptClassify();
    },
    (err) => showToast('خطأ في قراءة الأرشيف: ' + err.message, true),
  );

  loadPortfolio();
  syncOperations();

  onSnapshot(
    txCollection,
    (snap) => {
      transactions = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : 0,
        };
      });
      renderSummary();
      renderHoldings();
      renderTransactions();
    },
    (err) => showToast('خطأ في مزامنة العمليات: ' + err.message, true),
  );

  onSnapshot(
    priceCollection,
    (snap) => {
      prices = {};
      snap.docs.forEach((d) => {
        prices[d.id] = d.data().currentPrice;
      });
      renderSummary();
      renderHoldings();
    },
    (err) => showToast('خطأ في مزامنة الأسعار: ' + err.message, true),
  );

  onSnapshot(
    bondInfoCollection,
    (snap) => {
      bondInfo = {};
      snap.docs.forEach((d) => {
        bondInfo[d.id] = d.data();
      });
      renderHoldings();
    },
    (err) => showToast('خطأ في مزامنة بيانات الاستحقاق: ' + err.message, true),
  );
}

/* =====================================================================
 * حالة الاتصال بالإنترنت
 * ===================================================================== */
function updateOnlineStatus() {
  document.getElementById('statusDot').classList.toggle('offline', !navigator.onLine);
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

/* =====================================================================
 * Service Worker
 * ===================================================================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      // لا نزعج المستخدم بواجهة خاصة، لكن يجب أن يظهر الخطأ في console
      // المطوّر — بدون هذا يستحيل تشخيص سبب عدم ظهور زر التثبيت لاحقاً.
      console.error('فشل تسجيل Service Worker:', err);
    });
  });
}

/* =====================================================================
 * دعوة التثبيت (Add to Home Screen)
 * ---------------------------------------------------------------------
 * على Android/Chrome: نستخدم beforeinstallprompt (الطريقة الوحيدة الرسمية).
 * على iPhone/Safari: لا يوجد أي حدث JavaScript مكافئ إطلاقاً — أبل لا
 * تسمح لأي موقع بإطلاق تثبيت برمجياً. الخيار الوحيد المتاح هناك هو شرح
 * الخطوة اليدوية (زر المشاركة ← إضافة إلى الشاشة الرئيسية)، فنعرض نفس
 * شريط التثبيت لكن برسالة توضيحية بدل زر "تثبيت" الذي لا فائدة منه هناك.
 * ===================================================================== */
let deferredInstallPrompt = null;
const installBanner = document.getElementById('installBanner');
const installYesBtn = document.getElementById('installYesBtn');

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandaloneAlready =
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const IOS_HINT_DISMISSED_KEY = 'iosInstallHintDismissed';

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBanner.classList.remove('hidden');
});

installYesBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  installBanner.classList.add('hidden');
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
});

document.getElementById('installCloseBtn').addEventListener('click', () => {
  installBanner.classList.add('hidden');
  if (isIOS) localStorage.setItem(IOS_HINT_DISMISSED_KEY, '1');
});

window.addEventListener('appinstalled', () => {
  installBanner.classList.add('hidden');
});

if (isIOS && !isStandaloneAlready && !localStorage.getItem(IOS_HINT_DISMISSED_KEY)) {
  installBanner.querySelector('p').textContent =
    'لتثبيت التطبيق: اضغط زر المشاركة ⬆ في Safari ثم اختر "إضافة إلى الشاشة الرئيسية"';
  installYesBtn.classList.add('hidden'); // لا يوجد تثبيت برمجي على iOS، فقط تعليمات
  installBanner.classList.remove('hidden');
}
