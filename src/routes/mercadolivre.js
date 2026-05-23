const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ML_BASE = 'https://api.mercadolibre.com';

// Helper: get valid token
async function getToken() {
    const { data } = await supabase.from('ml_tokens').select('*').limit(1).single();
    if (!data) throw new Error('Token ML nao encontrado. Conecte sua conta primeiro.');
    return data.access_token;
}

// GET /api/ml/auth-url - returns ML authorization URL
router.get('/auth-url', (req, res) => {
    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.ML_APP_ID}&redirect_uri=${process.env.ML_REDIRECT_URI}`;
    res.json({ url });
});

// GET /api/ml/me - account info
router.get('/me', async (req, res) => {
    try {
          const token = await getToken();
          const { data } = await axios.get(`${ML_BASE}/users/me`, {
                  headers: { Authorization: `Bearer ${token}` }
          });
          res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ml/produtos - list active listings
router.get('/produtos', async (req, res) => {
    try {
          const token = await getToken();
          const me = await axios.get(`${ML_BASE}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
          const { data } = await axios.get(`${ML_BASE}/users/${me.data.id}/items/search?status=active&limit=50`, {
                  headers: { Authorization: `Bearer ${token}` }
          });
          res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ml/anuncio - create listing
router.post('/anuncio', async (req, res) => {
    try {
          const token = await getToken();
          const { title, price, quantity, description, category_id, pictures } = req.body;
          const item = {
                  title,
                  category_id: category_id || 'MLB1051',
                  price: parseFloat(price),
                  currency_id: 'BRL',
                  available_quantity: parseInt(quantity) || 1,
                  buying_mode: 'buy_it_now',
                  listing_type_id: 'gold_special',
                  condition: 'new',
                  description: { plain_text: description },
                  pictures: pictures || []
          };
          const { data } = await axios.post(`${ML_BASE}/items`, item, {
                  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
          });
          await supabase.from('produtos').insert({
                  ml_item_id: data.id,
                  title: data.title,
                  price: data.price,
                  status: data.status,
                  created_at: new Date().toISOString()
          });
          res.json({ success: true, item_id: data.id, permalink: data.permalink });
    } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /api/ml/pedidos - list orders
router.get('/pedidos', async (req, res) => {
    try {
          const token = await getToken();
          const me = await axios.get(`${ML_BASE}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
          const { data } = await axios.get(
                  `${ML_BASE}/orders/search?seller=${me.data.id}&sort=date_desc&limit=50`,
            { headers: { Authorization: `Bearer ${token}` } }
                );
          res.json(data.results || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ml/categorias/:query - search categories
router.get('/categorias/:query', async (req, res) => {
    try {
          const { data } = await axios.get(`${ML_BASE}/sites/MLB/domain_discovery/search?q=${req.params.query}&limit=5`);
          res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
