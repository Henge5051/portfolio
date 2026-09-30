import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

/* =========================================================
   ИНИЦИАЛИЗАЦИЯ
========================================================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
console.log('🤖 Telegram-бот запущен');

/* =========================================================
   HELPERS
========================================================= */
const fmt = (n) => new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0
}).format(n);

/**
 * Расчёт P&L портфеля по всем категориям
 * Наклейки: только свободные (не наклеенные на скины)
 */
function calcPnl(portfolio) {
  const assets = portfolio.assets || [];
  const skins = portfolio.skins || [];
  const stickers = (portfolio.stickers || []).filter(s => !s.applied);
  const cases = (portfolio.cases || []).filter(c => c.status === 'held');
  const trades = (portfolio.trades || []).filter(t => t.status === 'open');

  const iv = assets.reduce((s, a) => s + a.quantity * a.currentPrice, 0);
  const ic = assets.reduce((s, a) => s + a.quantity * a.buyPrice, 0);

  const sv = skins.reduce((s, x) => s + (x.quantity || 1) * x.currentPrice, 0);
  const sc = skins.reduce((s, x) => s + (x.quantity || 1) * x.buyPrice, 0);

  const stv = stickers.reduce((s, x) => s + (x.quantity || 1) * x.currentPrice, 0);
  const stc = stickers.reduce((s, x) => s + (x.quantity || 1) * x.buyPrice, 0);

  const cv = cases.reduce((s, c) => s + c.quantity * c.currentPrice, 0);
  const cc = cases.reduce((s, c) => s + c.quantity * c.buyPrice, 0);

  const tv = trades.reduce((s, t) => s + t.quantity * t.current, 0);
  const tc = trades.reduce((s, t) => s + t.quantity * t.entry, 0);

  const totalValue = iv + sv + stv + cv + tv;
  const totalCost = ic + sc + stc + cc + tc;

  return {
    totalValue,
    totalCost,
    pnl: totalValue - totalCost,
    investValue: iv,
    skinsValue: sv,
    stickersValue: stv,
    casesValue: cv,
    tradesValue: tv,
    counts: {
      assets: assets.length,
      skins: skins.length,
      stickers: stickers.length,
      cases: cases.length,
      trades: trades.length
    }
  };
}

/**
 * Создать/обновить ежедневный снимок портфеля
 */
async function createSnapshot(telegramId, portfolio) {
  const today = new Date().toISOString().slice(0, 10);

  const calc = calcPnl(portfolio);

  const { error } = await supabase
    .from('snapshots')
    .upsert({
      telegram_id: telegramId,
      snapshot_date: today,
      total_value: calc.totalValue,
      total_cost: calc.totalCost,
      total_pnl: calc.pnl,
      invest_value: calc.investValue,
      skins_value: calc.skinsValue,
      stickers_value: calc.stickersValue,
      cases_value: calc.casesValue,
      trades_value: calc.tradesValue,
      assets_count: calc.counts.assets,
      skins_count: calc.counts.skins,
      stickers_count: calc.counts.stickers,
      cases_count: calc.counts.cases,
      trades_count: calc.counts.trades
    }, { onConflict: 'telegram_id,snapshot_date' });

  if (error) {
    console.error('Snapshot error:', error.message);
    return false;
  }
  return true;
}

/* =========================================================
   HEALTH CHECK
========================================================= */
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'portfolio-backend', time: new Date() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

/* =========================================================
   API — ПОРТФЕЛИ
========================================================= */

// GET портфель пользователя
app.get('/api/portfolio', async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { data, error } = await supabase
    .from('portfolios')
    .select('*')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  if (!data) {
    const { data: created } = await supabase
      .from('portfolios')
      .insert({
        telegram_id: parseInt(telegram_id),
        data: { assets: [], skins: [], stickers: [], cases: [], trades: [] }
      })
      .select()
      .single();
    return res.json(created || { data: { assets: [], skins: [], stickers: [], cases: [], trades: [] } });
  }

  // Убедимся, что в data есть поле stickers (для старых портфелей)
  if (!data.data.stickers) {
    data.data.stickers = [];
  }

  res.json(data);
});

// POST — сохранить портфель
app.post('/api/portfolio', async (req, res) => {
  const { telegram_id, data, user } = req.body;
  if (!telegram_id || !data) {
    return res.status(400).json({ error: 'telegram_id and data required' });
  }

  // Гарантируем наличие всех полей
  if (!data.stickers) data.stickers = [];

  const { error } = await supabase
    .from('portfolios')
    .upsert({
      telegram_id: parseInt(telegram_id),
      username: user?.username || null,
      first_name: user?.first_name || null,
      data,
      updated_at: new Date().toISOString()
    }, { onConflict: 'telegram_id' });

  if (error) return res.status(500).json({ error: error.message });

  createSnapshot(parseInt(telegram_id), data).catch(e =>
    console.error('Snapshot on save failed:', e.message)
  );

  res.json({ ok: true });
});

// Статистика
app.get('/api/stats', async (req, res) => {
  const { count } = await supabase
    .from('portfolios')
    .select('*', { count: 'exact', head: true });
  res.json({ total_users: count || 0 });
});

/* =========================================================
   API — ИСТОРИЯ (СНИМКИ)
========================================================= */

app.get('/api/snapshots', async (req, res) => {
  const { telegram_id, days } = req.query;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  let query = supabase
    .from('snapshots')
    .select('*')
    .eq('telegram_id', telegram_id)
    .order('snapshot_date', { ascending: true });

  if (days && days !== 'all') {
    const d = parseInt(days);
    if (!isNaN(d) && d > 0) {
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - d);
      query = query.gte('snapshot_date', fromDate.toISOString().slice(0, 10));
    }
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ snapshots: data || [] });
});

app.post('/api/snapshots/create', async (req, res) => {
  const { telegram_id, portfolio } = req.body;
  if (!telegram_id || !portfolio) {
    return res.status(400).json({ error: 'telegram_id and portfolio required' });
  }

  const ok = await createSnapshot(parseInt(telegram_id), portfolio);
  res.json({ ok });
});

/* =========================================================
   КОМАНДЫ БОТА
========================================================= */

// /start
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'друг';
  bot.sendMessage(msg.chat.id,
    `👋 Привет, <b>${name}</b>!\n\n` +
    `Я — <b>Портфель</b>, твой трекер инвестиций, CS2 и трейдинга.\n\n` +
    `<b>Команды:</b>\n` +
    `/portfolio — открыть приложение\n` +
    `/pnl — сводка прибыли\n` +
    `/help — справка\n\n` +
    `👇 Или нажми кнопку внизу!`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '📊 Открыть портфель', web_app: { url: process.env.MINI_APP_URL } }
        ]]
      }
    }
  );
});

// /portfolio
bot.onText(/\/portfolio/, (msg) => {
  bot.sendMessage(msg.chat.id, '📊 Открываю...', {
    reply_markup: {
      inline_keyboard: [[
        { text: '🚀 Открыть', web_app: { url: process.env.MINI_APP_URL } }
      ]]
    }
  });
});

// /pnl
bot.onText(/\/pnl/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  const { data, error } = await supabase
    .from('portfolios')
    .select('data')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (error || !data) {
    return bot.sendMessage(chatId, '❌ Портфель не найден. Открой приложение: /portfolio');
  }

  const calc = calcPnl(data.data);
  const pnlPct = calc.totalCost > 0 ? (calc.pnl / calc.totalCost) * 100 : 0;
  const emoji = calc.pnl >= 0 ? '📈' : '📉';
  const sign = calc.pnl >= 0 ? '+' : '';

  const text = `
${emoji} <b>Твой портфель</b>

💰 Стоимость: <b>${fmt(calc.totalValue)}</b>
💵 Вложено: ${fmt(calc.totalCost)}
${emoji} P&L: <b>${sign}${fmt(calc.pnl)}</b> (${sign}${pnlPct.toFixed(2)}%)

<b>Разбивка:</b>
💼 Инвестиции: ${fmt(calc.investValue)}
🎮 Скины: ${fmt(calc.skinsValue)}
🎨 Наклейки: ${fmt(calc.stickersValue)}
📦 Кейсы: ${fmt(calc.casesValue)}
💹 Трейдинг: ${fmt(calc.tradesValue)}

<i>${new Date().toLocaleString('ru-RU')}</i>
`.trim();

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '📊 Детали', web_app: { url: process.env.MINI_APP_URL } }
      ]]
    }
  });
});

// /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 <b>Команды:</b>\n\n` +
    `/start — запустить\n` +
    `/portfolio — открыть приложение\n` +
    `/pnl — прибыль/убыток\n` +
    `/help — справка\n\n` +
    `💡 Заглядывай каждый вечер — присылаю дневной отчёт в 20:00`,
    { parse_mode: 'HTML' }
  );
});

/* =========================================================
   PUSH-УВЕДОМЛЕНИЯ
========================================================= */

async function sendPush(telegramId, text) {
  try {
    await bot.sendMessage(telegramId, text, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Push failed:', e.message);
  }
}

// Ежедневный отчёт в 20:00 МСК
cron.schedule('0 20 * * *', async () => {
  console.log('📤 Ежедневные отчёты...');
  const { data: portfolios } = await supabase
    .from('portfolios')
    .select('telegram_id, data');

  if (!portfolios) return;

  for (const p of portfolios) {
    try {
      const calc = calcPnl(p.data);
      const emoji = calc.pnl >= 0 ? '📈' : '📉';
      await sendPush(p.telegram_id,
        `${emoji} <b>Отчёт за день</b>\n\n` +
        `💰 Портфель: <b>${fmt(calc.totalValue)}</b>\n` +
        `📊 P&L: <b>${calc.pnl >= 0 ? '+' : ''}${fmt(calc.pnl)}</b>`
      );
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.error(`Push error to ${p.telegram_id}:`, e.message);
    }
  }
  console.log(`✅ Отчёты отправлены ${portfolios.length} пользователям`);
}, { timezone: 'Europe/Moscow' });

// Ежедневные снимки в 23:55 МСК
cron.schedule('55 23 * * *', async () => {
  console.log('📸 Создание ежедневных снимков...');
  const { data: portfolios } = await supabase
    .from('portfolios')
    .select('telegram_id, data');

  if (!portfolios) return;

  for (const p of portfolios) {
    try {
      await createSnapshot(p.telegram_id, p.data);
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.error(`Snapshot error for ${p.telegram_id}:`, e.message);
    }
  }
  console.log(`✅ Снимки созданы для ${portfolios.length} пользователей`);
}, { timezone: 'Europe/Moscow' });

/* =========================================================
   ЗАПУСК
========================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend на порту ${PORT}`));

/* =========================================================
   ОБРАБОТКА ОШИБОК
========================================================= */
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});