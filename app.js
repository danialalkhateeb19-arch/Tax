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

/* =====================================================================
 * [مرحلة 1] إعدادات المزامنة مع تنكوف (عبر وسيط Vercel)
 * ===================================================================== */
const PROXY_BASE = 'https://tinkoff-vercel.vercel.app';
// تاريخ فتح حساب Future Tax Fund — منه تبدأ المزامنة لتغطية كل التاريخ.
const ACCOUNT_OPENED = '2024-02-01';

/* =====================================================================
 * الحالة العامة
 * ===================================================================== */
let transactions = []; // [{ id, type: 'buy'|'sell', symbol, date, qty, price, commission }]
let prices = {}; // { symbol: currentPrice }
let bondInfo = {}; // { symbol: { maturityDate, couponValue, paymentsPerYear } }
let selectedType = 'buy';

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
function renderSummary() {
  const holdings = computeHoldings(transactions);
  const s = computeSummary(holdings);

  setMetric('sumCurrentValue', formatMoney(s.currentValue), 'neutral');
  setMetric('sumTotalCost', formatMoney(s.totalCost), 'neutral');
  setMetric('sumUnrealized', formatMoney(s.unrealizedPL), toneClass(s.unrealizedPL));
  setMetric('sumRealized', formatMoney(s.realizedPL), toneClass(s.realizedPL));
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
  const holdings = computeHoldings(transactions).filter((h) => h.qty > 0.0001);

  if (holdings.length === 0) {
    container.innerHTML = '<p class="empty">لا توجد سندات مملوكة حالياً</p>';
    return;
  }

  container.innerHTML = holdings
    .map((h) => {
      const avgCost = h.totalCost / h.qty;
      const price = prices[h.symbol] ?? avgCost;
      const value = h.qty * price;
      const pl = value - h.totalCost;
      const tone = toneClass(pl);
      const priceValue = prices[h.symbol] !== undefined ? prices[h.symbol] : '';

      return `
        <div class="holding-row">
          <div class="holding-top">
            <div>
              <div class="holding-symbol">${escapeHtml(h.symbol)}</div>
              <div class="holding-qty">الكمية: ${formatQty(h.qty)} · متوسط التكلفة: ${formatMoney(avgCost)}</div>
            </div>
            <div class="holding-value">
              <div class="amount tabular">${formatMoney(value)}</div>
              <div class="pl tabular ${tone}">${pl >= 0 ? '+' : ''}${formatMoney(pl)}</div>
            </div>
          </div>
          <div class="price-input-row">
            <label>السعر الحالي</label>
            <input
              type="number" inputmode="decimal" step="0.01" min="0"
              placeholder="${formatMoney(avgCost)}"
              value="${priceValue}"
              data-price-symbol="${escapeAttr(h.symbol)}"
            />
          </div>
          ${
            bondInfo[h.symbol]
              ? `<div class="holding-qty">تاريخ الاستحقاق: ${bondInfo[h.symbol].maturityDate ?? '—'} · قيمة الكوبون: ${bondInfo[h.symbol].couponValue ?? '—'} · دفعات/سنة: ${bondInfo[h.symbol].paymentsPerYear ?? '—'}</div>`
              : ''
          }
        </div>`;
    })
    .join('');

  container.querySelectorAll('[data-price-symbol]').forEach((input) => {
    input.addEventListener('change', onPriceChange);
  });
}

async function fetchMoexBondInfo(symbol) {
  const boards = ['TQOB', 'TQCB', 'TQIR'];
  for (const board of boards) {
    try {
      const url = `https://iss.moex.com/iss/engines/stock/markets/bonds/boards/${board}/securities/${encodeURIComponent(symbol)}.json?iss.meta=off`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      const cols = json?.description?.columns;
      const rows = json?.description?.data;
      if (!Array.isArray(cols) || !Array.isArray(rows)) continue;

      const nameIdx = cols.indexOf('name');
      const valueIdx = cols.indexOf('value');
      if (nameIdx === -1 || valueIdx === -1) continue;

      const fields = {};
      rows.forEach((r) => (fields[r[nameIdx]] = r[valueIdx]));

      const maturityDate = /^\d{4}-\d{2}-\d{2}$/.test(fields['MATDATE']) ? fields['MATDATE'] : null;
      const couponValue = fields['COUPONVALUE'] !== undefined ? parseFloat(fields['COUPONVALUE']) : null;
      const couponPeriod = fields['COUPONPERIOD'] !== undefined ? parseFloat(fields['COUPONPERIOD']) : null;
      const paymentsPerYear = couponPeriod ? Math.round(365 / couponPeriod) : null;

      if (!maturityDate && couponValue === null) continue;
      return { maturityDate, couponValue, paymentsPerYear };
    } catch {
      continue;
    }
  }
  return null;
}

async function saveMoexBondInfoIfFound(symbol) {
  if (!bondInfoCollection) return;
  const info = await fetchMoexBondInfo(symbol);
  if (!info) return;
  try {
    await setDoc(doc(bondInfoCollection, symbol), { symbol, ...info, updatedAt: serverTimestamp() });
  } catch {
    // تجاهل بصمت
  }
}

async function fetchMoexPrice(symbol) {
  const boards = ['TQOB', 'TQCB', 'TQIR'];
  for (const board of boards) {
    try {
      const url = `https://iss.moex.com/iss/engines/stock/markets/bonds/boards/${board}/securities/${encodeURIComponent(symbol)}.json?iss.meta=off`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      const cols = json?.marketdata?.columns;
      const rows = json?.marketdata?.data;
      if (!Array.isArray(cols) || !Array.isArray(rows) || !rows[0]) continue;
      const idx = cols.indexOf('LAST');
      const last = idx !== -1 ? rows[0][idx] : null;
      if (last !== null && last !== undefined && !Number.isNaN(parseFloat(last))) {
        return parseFloat(last);
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function saveMoexPriceIfFound(symbol) {
  if (!priceCollection) return;
  const price = await fetchMoexPrice(symbol);
  if (price === null) return;
  try {
    await setDoc(doc(priceCollection, symbol), { symbol, currentPrice: price, updatedAt: serverTimestamp() });
  } catch {
    // تجاهل بصمت — يبقى الإدخال اليدوي متاحاً
  }
}

async function onPriceChange(e) {
  const symbol = e.target.dataset.priceSymbol;
  const value = parseFloat(e.target.value);
  if (Number.isNaN(value) || value < 0) return;

  try {
    await setDoc(doc(priceCollection, symbol), { symbol, currentPrice: value, updatedAt: serverTimestamp() });
  } catch (err) {
    showToast('تعذّر حفظ السعر: ' + err.message, true);
  }
}

/* =====================================================================
 * العرض — سجل العمليات
 * ===================================================================== */
function renderTransactions() {
  const container = document.getElementById('txList');

  if (transactions.length === 0) {
    container.innerHTML = '<p class="empty">لا توجد عمليات مسجلة بعد</p>';
    return;
  }

  const sorted = [...transactions].sort(
    (a, b) => b.date.localeCompare(a.date) || (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0),
  );

  container.innerHTML = sorted
    .map((tx) => {
      const total = tx.qty * tx.price;
      const label = tx.type === 'buy' ? 'شراء' : 'بيع';
      return `
        <div class="tx-row">
          <span class="tx-badge ${tx.type}">${label}</span>
          <div class="tx-main">
            <div class="tx-symbol">${escapeHtml(tx.symbol)}</div>
            <div class="tx-details">${tx.date} · ${formatQty(tx.qty)} وحدة × ${formatMoney(tx.price)}${tx.commission ? ' · عمولة ' + formatMoney(tx.commission) : ''}</div>
          </div>
          <div style="text-align:left;">
            <div class="tx-amount tabular">${formatMoney(total)}</div>
            <button type="button" class="btn-danger-ghost" data-delete-id="${tx.id}">حذف</button>
          </div>
        </div>`;
    })
    .join('');

  container.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', onDeleteTransaction);
  });
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
 * نموذج إضافة عملية
 * ===================================================================== */
const txForm = document.getElementById('txForm');
const sellWarning = document.getElementById('sellWarning');
const txSubmitBtn = document.getElementById('txSubmitBtn');

document.querySelectorAll('.type-toggle button').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedType = btn.dataset.type;
    document.querySelectorAll('.type-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
    txSubmitBtn.textContent = selectedType === 'buy' ? 'حفظ عملية الشراء' : 'حفظ عملية البيع';
    validateSellQuantity();
  });
});

document.getElementById('txSymbol').addEventListener('input', validateSellQuantity);
document.getElementById('txQty').addEventListener('input', validateSellQuantity);

function validateSellQuantity() {
  if (selectedType !== 'sell') {
    sellWarning.classList.add('hidden');
    txSubmitBtn.disabled = false;
    return;
  }
  const symbol = document.getElementById('txSymbol').value.trim();
  const qty = parseFloat(document.getElementById('txQty').value);
  if (!symbol || !qty) {
    sellWarning.classList.add('hidden');
    txSubmitBtn.disabled = false;
    return;
  }
  const available = availableQtyFor(symbol);
  if (qty > available) {
    sellWarning.textContent = `الكمية المتاحة من "${symbol}" هي ${formatQty(available)} فقط`;
    sellWarning.classList.remove('hidden');
    txSubmitBtn.disabled = true;
  } else {
    sellWarning.classList.add('hidden');
    txSubmitBtn.disabled = false;
  }
}

txForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const symbol = document.getElementById('txSymbol').value.trim();
  const date = document.getElementById('txDate').value;
  const qty = parseFloat(document.getElementById('txQty').value);
  const price = parseFloat(document.getElementById('txPrice').value);
  const commission = parseFloat(document.getElementById('txCommission').value) || 0;

  if (!symbol || !date || !qty || qty <= 0 || !price || price <= 0) {
    showToast('يرجى تعبئة كل الحقول المطلوبة بشكل صحيح', true);
    return;
  }

  if (selectedType === 'sell' && qty > availableQtyFor(symbol)) {
    showToast('لا يمكن بيع كمية أكبر مما تملك', true);
    return;
  }

  if (!txCollection) {
    showToast('التطبيق لا يزال يتصل — أعد المحاولة بعد لحظة', true);
    return;
  }

  txSubmitBtn.disabled = true;
  txSubmitBtn.textContent = 'جارٍ الحفظ…';

  try {
    await addDoc(txCollection, {
      type: selectedType,
      symbol,
      date,
      qty,
      price,
      commission,
      createdAt: serverTimestamp(),
    });
    showToast(selectedType === 'buy' ? 'تم حفظ عملية الشراء' : 'تم حفظ عملية البيع');
    txForm.reset();
    document.getElementById('txDate').value = todayISO();
    saveMoexPriceIfFound(symbol);
    saveMoexBondInfoIfFound(symbol);
  } catch (err) {
    showToast('تعذّر الحفظ: ' + err.message, true);
  } finally {
    txSubmitBtn.disabled = false;
    txSubmitBtn.textContent = selectedType === 'buy' ? 'حفظ عملية الشراء' : 'حفظ عملية البيع';
  }
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
document.getElementById('txDate').value = todayISO();

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

  // [مرحلة 1] مزامنة أرشيف تنكوف في الخلفية (لا تلمس العرض الحالي).
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
      validateSellQuantity();
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
