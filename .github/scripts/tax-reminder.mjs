/**
 * بوت تذكير الضريبة — تيليغرام
 * =====================================================================
 * يعمل عبر GitHub Actions كل نصف ساعة. لا يحتاج أي خادم.
 *
 * ماذا يفعل في كل تشغيل:
 *   1) يسأل تيليغرام: هل ضغطتُ زراً منذ آخر مرة؟ (getUpdates)
 *   2) يسجّل الشهور التي أكّدتها في bot-state.json
 *   3) يحسب الشهور المستحقة غير المؤكّدة
 *   4) إن وُجدت — وكان الوقت مناسباً ولم يُرسل اليوم — يرسل تذكيراً
 *
 * قاعدة الاستحقاق: الشهر يصير مستحقاً يوم 25 منه، ويبقى في القائمة
 * حتى تؤكّده — ولو مرّت شهور. لذلك لا يضيع شهر أبداً.
 * ===================================================================== */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = 'bot-state.json';

/** أول شهر يتتبّعه البوت. غيّره إن أردت البدء من شهر أسبق. */
const START_MONTH = process.env.START_MONTH || '2026-07';

/**
 * ساعة الإرسال بتوقيت موسكو. الرسالة تُبعث مرة واحدة في اليوم فقط —
 * أي تشغيل آخر خلال اليوم لا يرسل شيئاً، إنما يستمع لضغطات الأزرار.
 */
const SEND_AFTER_HOUR = 9;

/** اليوم الذي يصبح فيه شهر الراتب مستحقاً للتأكيد. */
const DUE_DAY = 25;

if (!TOKEN || !CHAT_ID) {
  console.error('ناقص TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_ID');
  process.exit(1);
}

/* ─────────────────────────────────────────────────────── أدوات ───── */

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

const monthLabel = (key) => {
  const [y, m] = key.split('-');
  return `${AR_MONTHS[Number(m) - 1]} ${y}`;
};

/** الوقت الحالي بتوقيت موسكو، مهما كان توقيت الخادم. */
function moscowNow() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' });
  const [date, time] = s.split(' ');
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d, hour: Number(time.slice(0, 2)), date, monthKey: `${y}-${String(m).padStart(2, '0')}` };
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.error(`تيليغرام ${method} فشل:`, json.description || res.status);
  return json;
}

/* ─────────────────────────────────────────────────────── الحالة ──── */

const blank = { confirmed: {}, offset: 0, lastReminder: null, lastMessageId: null };
const state = existsSync(STATE_FILE)
  ? { ...blank, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }
  : { ...blank };
const before = JSON.stringify(state);

/* ───────────────────────── 1) قراءة الضغطات الجديدة ──────────────── */

const updates = await tg('getUpdates', { offset: state.offset, timeout: 0, limit: 100 });
let justConfirmed = [];

for (const u of updates.result || []) {
  state.offset = Math.max(state.offset, u.update_id + 1);

  // ضغطة زر
  const cb = u.callback_query;
  if (cb && String(cb.message?.chat?.id) === String(CHAT_ID)) {
    const data = String(cb.data || '');
    if (data.startsWith('done:')) {
      const key = data.slice(5);
      const keys = key === 'all' ? pendingMonths(state) : [key];
      for (const k of keys) {
        if (!state.confirmed[k]) { state.confirmed[k] = moscowNow().date; justConfirmed.push(k); }
      }
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'تم التسجيل ✅' });
    }
    continue;
  }

  // أو كلمة «تم» نصاً — تؤكّد أقدم شهر معلّق
  const msg = u.message;
  if (msg && String(msg.chat?.id) === String(CHAT_ID)) {
    const text = String(msg.text || '').trim();
    if (['تم', 'دفعت', 'ok', 'done'].includes(text.toLowerCase())) {
      const p = pendingMonths(state);
      if (p[0]) { state.confirmed[p[0]] = moscowNow().date; justConfirmed.push(p[0]); }
    }
  }
}

/* ────────────────────── 2) حساب الشهور المستحقة ──────────────────── */

function pendingMonths(st) {
  const now = moscowNow();
  const out = [];
  let [y, m] = START_MONTH.split('-').map(Number);
  for (let i = 0; i < 240; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const isCurrent = key === now.monthKey;
    if (key > now.monthKey) break;
    // الشهر الحالي لا يُطالَب به قبل يوم 25؛ الشهور السابقة مستحقة دائماً
    const due = isCurrent ? now.d >= DUE_DAY : true;
    if (due && !st.confirmed[key]) out.push(key);
    if (isCurrent) break;
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const now = moscowNow();
const pending = pendingMonths(state);

/* ─────────────────────── 3) تحديث رسالة سابقة ────────────────────── */

if (justConfirmed.length && state.lastMessageId) {
  const done = justConfirmed.map(monthLabel).join(' · ');
  await tg('editMessageText', {
    chat_id: CHAT_ID,
    message_id: state.lastMessageId,
    text: `✅ مسجَّل: ${done}\n\n${pending.length ? `ما زال معلّقاً: ${pending.map(monthLabel).join(' · ')}` : 'كل الشهور مؤكّدة. لا تذكيرات حتى الشهر القادم.'}`,
  });
  if (!pending.length) state.lastMessageId = null;
}

/* ───────────────────────────── 4) الإرسال ────────────────────────── */

const alreadySentToday = state.lastReminder === now.date;
const shouldSend = pending.length > 0 && !alreadySentToday && now.hour >= SEND_AFTER_HOUR;

if (shouldSend) {
  const overdue = pending.filter((k) => k !== now.monthKey);
  const lines = [
    '⏳ *تذكير الضريبة*',
    '',
    pending.length === 1
      ? `هل سحبتَ مبلغ ضريبة *${monthLabel(pending[0])}* من راتبك وأودعتَه في حساب الضريبة؟`
      : 'هل سحبتَ مبالغ الضريبة التالية من راتبك وأودعتَها في حساب الضريبة؟',
  ];
  if (pending.length > 1) lines.push('', pending.map((k) => `• ${monthLabel(k)}`).join('\n'));
  if (overdue.length) lines.push('', `⚠️ متأخّر: ${overdue.map(monthLabel).join(' · ')}`);
  lines.push('', '_يتكرّر هذا التذكير يومياً حتى تؤكّد._');

  const buttons = pending.map((k) => [{ text: `✅ ${monthLabel(k)}`, callback_data: `done:${k}` }]);
  if (pending.length > 1) buttons.push([{ text: '✅ أكّد الكل', callback_data: 'done:all' }]);

  const sent = await tg('sendMessage', {
    chat_id: CHAT_ID,
    text: lines.join('\n'),
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  });

  if (sent.ok) {
    state.lastReminder = now.date;
    state.lastMessageId = sent.result.message_id;
    console.log('أُرسل تذكير لـ:', pending.join(', '));
  }
} else {
  console.log(`لا إرسال — معلّق: ${pending.length} · أُرسل اليوم: ${alreadySentToday} · الساعة: ${now.hour}`);
}

/* ─────────────────────────── 5) حفظ الحالة ───────────────────────── */

if (JSON.stringify(state) !== before) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log('تغيّرت الحالة — ستُحفظ.');
}
