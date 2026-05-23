require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

// Routes
app.use('/api/ml', require('./routes/mercadolivre'));
app.use('/api/cj', require('./routes/cjdropshipping'));
app.use('/api/produtos', require('./routes/produtos'));
app.use('/api/pedidos', require('./routes/pedidos'));
app.use('/api/dashboard', require('./routes/dashboard'));

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'DropFacil Backend OK', version: '1.0.0' });
});

// ML OAuth callback
app.get('/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Code missing' });
    try {
          const axios = require('axios');
          const response = await axios.post(
                  `https://api.mercadolibre.com/oauth/token`,
                  new URLSearchParams({
                            grant_type: 'authorization_code',
                            client_id: process.env.ML_APP_ID,
                            client_secret: process.env.ML_CLIENT_SECRET,
                            code,
                            redirect_uri: process.env.ML_REDIRECT_URI
                  }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
                );
          const { access_token, refresh_token, user_id } = response.data;
          await supabase.from('ml_tokens').upsert({
                  user_id: user_id.toString(),
                  access_token,
                  refresh_token,
                  updated_at: new Date().toISOString()
          });
          res.json({ success: true, message: 'Conta ML conectada!', user_id });
    } catch (err) {
          res.status(500).json({ error: err.response?.data || err.message });
    }
});

// Cron: sync orders every 15 min
cron.schedule('*/15 * * * *', async () => {
    console.log('[CRON] Sincronizando pedidos ML...');
    try {
          const axios = require('axios');
          const { data: tokens } = await supabase.from('ml_tokens').select('*');
          for (const token of tokens || []) {
                  const res = await axios.get(
                            `https://api.mercadolibre.com/orders/search?seller=${token.user_id}&sort=date_desc&limit=10`,
                    { headers: { Authorization: `Bearer ${token.access_token}` } }
                          );
                  const orders = res.data.results || [];
                  for (const order of orders) {
                            await supabase.from('pedidos').upsert({
                                        ml_order_id: order.id.toString(),
                                        status: order.status,
                                        total: order.total_amount,
                                        buyer_name: order.buyer?.nickname,
                                        created_at: order.date_created,
                                        updated_at: new Date().toISOString()
                            }, { onConflict: 'ml_order_id' });
                  }
          }
          console.log('[CRON] Pedidos sincronizados!');
    } catch (e) {
          console.error('[CRON] Erro:', e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DropFacil Backend rodando na porta ${PORT}`));
