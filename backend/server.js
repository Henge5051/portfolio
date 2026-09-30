import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Валидация Telegram initData
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateTelegramData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (calculatedHash !== hash) return null;

  try {
    const user = JSON.parse(params.get('user') || '{}');
    return user;
  } catch { return null; }
}

/**
 * GET /api/portfolio?telegram_id=123
 * Загрузить портфель пользователя
 */
app.get('/api/portfolio', async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { data, error } = await supabase
    .from('portfolios')
    .select('*')
    .eq('telegram_id', telegram_id)
    .single();

  if (error && error.code !== 'PGRST116') {
    return res.status(500).json({ error: error.message });
  }

  if (!data) {
    // Создать новый портфель
    const { data: created } = await supabase
      .from('portfolios')
      .insert({ telegram_id: parseInt(telegram_id), data: { assets: [], skins: [], cases: [], trades: [] } })
      .select()
      .single();
    return res.json(created || { data: { assets: [], skins: [], cases: [], trades: [] } });
  }

  res.json(data);
});

/**
 * POST /api/portfolio
 * Сохранить портфель
 */
app.post('/api/portfolio', async (req, res) => {
  const { telegram_id, data, user } = req.body;

  if (!telegram_id || !data) {
    return res.status(400).json({ error: 'telegram_id and data required' });
  }

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

  res.json({ ok: true });
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend на порту ${PORT}`));