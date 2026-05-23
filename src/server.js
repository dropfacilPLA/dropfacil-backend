require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use('/api/ml', require('./routes/mercadolivre'));
app.use('/api/cj', require('./routes/cjdropshipping'));
app.use('/api/produtos', require('./routes/produtos'));
app.use('/api/pedidos', require('./routes/pedidos'));
app.use('/api/dashboard', require('./routes/dashboard'));

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Buscar produtos CJ com margem calculada
app.get('/api/buscar-produtos', async (req, res) => {
  try {
    const { q = '', page = 1 } = req.query;
    const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
    const tokenRes = await axios.post(CJ_BASE + '/authentication/getAccessToken',
      { apiKey: process.env.CJ_API_KEY },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const token = tokenRes.data.data.accessToken;
    const params = q ? { productName: q, pageNum: page, pageSize: 20 } : { pageNum: page, pageSize: 20 };
    const { data } = await axios.get(CJ_BASE + '/product/list', { params, headers: { 'CJ-Access-Token': token } });
    const prods = (data.data?.list || data.data || []).map(p => ({
      pid: p.pid, nome: p.productNameEn || p.productName,
      sku: p.productSku, imagem: p.productImage,
      preco_cj: parseFloat(p.sellPrice) || 0,
      categoria: p.categoryName, peso: p.productWeight
    }));
    res.json(prods);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Publicar produto CJ no Mercado Livre
app.post('/api/publicar', async (req, res) => {
  try {
    const { pid, titulo, preco_brl, imagem, categoria_ml, quantidade } = req.body;
    const { data: tokenData } = await supabase.from('ml_tokens').select('access_token,user_id').limit(1).single();
    if (!tokenData) return res.status(400).json({ error: 'ML nao conectado' });
    const listing = {
      title: titulo,
      category_id: categoria_ml || 'MLB271599',
      price: preco_brl,
      currency_id: 'BRL',
      available_quantity: quantidade || 10,
      buying_mode: 'buy_it_now',
      condition: 'new',
      listing_type_id: 'gold_special',
      description: { plain_text: titulo },
      pictures: [{ source: imagem }],
      shipping: { mode: 'me2', free_shipping: true }
    };
    const { data } = await axios.post('https://api.mercadolibre.com/items', listing, {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    await supabase.from('produtos').upsert({
      ml_item_id: data.id, cj_pid: pid, titulo,
      preco_ml: preco_brl, imagem, status: 'active', ml_user_id: tokenData.user_id
    });
    res.json({ success: true, ml_id: data.id, permalink: data.permalink });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

// Dashboard - servir o HTML
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send('<h2>DropFacil Online. Acesse <a href="/api/cj/test">/api/cj/test</a> para testar.</h2>');
  }
});

// CRON: sync pedidos a cada 15 min
cron.schedule('*/15 * * * *', async () => {
  try {
    const { data: tokens } = await supabase.from('ml_tokens').select('access_token,user_id').limit(1);
    if (!tokens?.length) return;
    const t = tokens[0];
    const r = await axios.get('https://api.mercadolibre.com/orders/search?seller=' + t.user_id + '&sort=date_desc&limit=50', {
      headers: { Authorization: 'Bearer ' + t.access_token }
    });
    for (const o of r.data.results || []) {
      await supabase.from('pedidos').upsert({
        ml_order_id: String(o.id),
        buyer_name: o.buyer?.nickname || 'Desconhecido',
        total: o.total_amount, status: o.status,
        ml_user_id: t.user_id, created_at: o.date_created
      }, { onConflict: 'ml_order_id' });
    }
    console.log('[CRON] Pedidos sincronizados:', r.data.results?.length || 0);
  } catch (e) { console.error('[CRON]', e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('DropFacil porta ' + PORT));
