cat > server.js << 'EOF'
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
console.log('🤖 Бот запущен');

const fmt = (n) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);

function calcPnl(p) {
  let tv = 0, tc = 0;
  p.assets?.forEach(a => { tv += a.quantity * a.currentPrice; tc += a.quantity * a.buyPrice; });
  p.skins?.forEach(s => { const q = s.quantity || 1; tv += q * s.currentPrice; tc += q * s.buyPrice; });
  p.cases?.filter(c => c.status === 'held').forEach(c => { tv += c.quantity * c.currentPrice; tc += c.quantity * c.buyPrice; });
  return { totalValue: tv, totalCost: tc, pnl: tv - tc };
}

// API
app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.get('/api/portfolio', async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id) return res.status(400).json({ error: 'required' });
  const { data, error } = await supabase.from('portfolios').select('*').eq('telegram_id', telegram_id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) {
    const { data: created } = await supabase.from('portfolios').insert({
      telegram_id: parseInt(telegram_id),
      data: { assets: [], skins: [], cases: [], trades: [] }
    }).select().single();
    return res.json(created || { data: { assets: [], skins: [], cases: [], trades: [] } });
  }
  res.json(data);
});

app.post('/api/portfolio', async (req, res) => {
  const { telegram_id, data, user } = req.body;
  if (!telegram_id || !data) return res.status(400).json({ error: 'required' });
  const { error } = await supabase.from('portfolios').upsert({
    telegram_id: parseInt(telegram_id),
    username: user?.username || null,
    first_name: user?.first_name || null,
    data,
    updated_at: new Date().toISOString()
  }, { onConflict: 'telegram_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Команды бота
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 Привет, <b>${msg.from.first_name || 'друг'}</b>!\n\n` +
    `Я — <b>Портфель</b>, твой трекер инвестиций.\n\n` +
    `<b>Команды:</b>\n` +
    `/portfolio — открыть приложение\n` +
    `/pnl — сводка прибыли\n` +
    `/help — справка`,
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

bot.onText(/\/portfolio/, (msg) => {
  bot.sendMessage(msg.chat.id, '📊 Открываю...', {
    reply_markup: {
      inline_keyboard: [[
        { text: '🚀 Открыть', web_app: { url: process.env.MINI_APP_URL } }
      ]]
    }
  });
});

bot.onText(/\/pnl/, async (msg) => {
  const { data } = await supabase.from('portfolios').select('data').eq('telegram_id', msg.from.id).maybeSingle();
  if (!data) return bot.sendMessage(msg.chat.id, '❌ Портфель не найден. Открой: /portfolio');

  const { totalValue, totalCost, pnl } = calcPnl(data.data);
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
  const emoji = pnl >= 0 ? '📈' : '📉';
  const sign = pnl >= 0 ? '+' : '';

  bot.sendMessage(msg.chat.id,
    `${emoji} <b>Твой портфель</b>\n\n` +
    `💰 Стоимость: <b>${fmt(totalValue)}</b>\n` +
    `💵 Вложено: ${fmt(totalCost)}\n` +
    `${emoji} P&L: <b>${sign}${fmt(pnl)}</b> (${sign}${pnlPct.toFixed(2)}%)`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, '📖 /start — запуск\n/portfolio — приложение\n/pnl — прибыль');
});

// Ежедневный отчёт в 20:00
cron.schedule('0 20 * * *', async () => {
  const { data: portfolios } = await supabase.from('portfolios').select('telegram_id, data');
  if (!portfolios) return;
  for (const p of portfolios) {
    try {
      const { totalValue, pnl } = calcPnl(p.data);
      const emoji = pnl >= 0 ? '📈' : '📉';
      await bot.sendMessage(p.telegram_id,
        `${emoji} <b>Отчёт за день</b>\n\n💰 ${fmt(totalValue)}\n📊 P&L: <b>${pnl >= 0 ? '+' : ''}${fmt(pnl)}</b>`,
        { parse_mode: 'HTML' }
      );
      await new Promise(r => setTimeout(r, 100));
    } catch (e) { console.error(e.message); }
  }
}, { timezone: 'Europe/Moscow' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend на порту ${PORT}`));
EOF