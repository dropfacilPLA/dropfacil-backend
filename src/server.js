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

// Servir arquivos estaticos
app.use(express.static(path.join(__dirname, 'public')));

// ==================== OAuth Mercado Livre ====================

// GET /auth/mercadolivre - redireciona para autorizacao ML
app.get('/auth/mercadolivre', (req, res) => {
  const url = 'https://auth.mercadolivre.com.br/authorization?response_type=code' +
    '&client_id=' + process.env.ML_APP_ID +
    '&redirect_uri=' + encodeURIComponent(process.env.ML_REDIRECT_URI);
  res.redirect(url);
});

// GET /auth/callback - ML retorna com code, trocamos por token
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?erro=sem_code');
  try {
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      code,
      redirect_uri: process.env.ML_REDIRECT_URI
    }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    // Salva token no Supabase
    await supabase.from('ml_tokens').upsert({
      user_id: String(data.user_id),
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    console.log('[ML OAuth] Token salvo para user_id:', data.user_id);
    res.redirect('/?ml=conectado');
  } catch (e) {
    console.error('[ML OAuth] Erro:', e.response?.data || e.message);
    res.redirect('/?erro=oauth_falhou');
  }
});

// POST /api/ml/refresh-token - renova token expirado
app.post('/api/ml/refresh-token', async (req, res) => {
  try {
    const { data: row } = await supabase.from('ml_tokens').select('refresh_token,user_id').limit(1).single();
    if (!row) return res.status(400).json({ error: 'Token nao encontrado' });
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: row.refresh_token
    }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    await supabase.from('ml_tokens').update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      updated_at: new Date().toISOString()
    }).eq('user_id', row.user_id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// POST /api/ml/sync-orders - sincroniza pedidos manualmente
app.post('/api/ml/sync-orders', async (req, res) => {
  try {
    const { data: tokens } = await supabase.from('ml_tokens').select('access_token,user_id').limit(1);
    if (!tokens?.length) return res.status(400).json({ error: 'ML nao conectado' });
    const t = tokens[0];
    const r = await axios.get('https://api.mercadolibre.com/orders/search?seller=' + t.user_id + '&sort=date_desc&limit=50', {
      headers: { Authorization: 'Bearer ' + t.access_token }
    });
    let count = 0;
    for (const o of r.data.results || []) {
      await supabase.from('pedidos').upsert({
        ml_order_id: String(o.id),
        buyer_name: o.buyer?.nickname || 'Desconhecido',
        total: o.total_amount, status: o.status,
        ml_user_id: t.user_id, created_at: o.date_created
      }, { onConflict: 'ml_order_id' });
      count++;
    }
    res.json({ success: true, message: count + ' pedidos sincronizados' });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

// ==================== Buscar produtos CJ ====================

app.get('/api/buscar-produtos', async (req, res) => {
  try {
    const { q = '', page = 1, limit = 20 } = req.query;
    const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
    const tokenRes = await axios.post(CJ_BASE + '/authentication/getAccessToken',
      { apiKey: process.env.CJ_API_KEY },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const token = tokenRes.data.data.accessToken;
    const params = q
      ? { productName: q, pageNum: page, pageSize: Math.min(parseInt(limit)||20, 50) }
      : { pageNum: page, pageSize: Math.min(parseInt(limit)||20, 50) };
    const { data } = await axios.get(CJ_BASE + '/product/list', { params, headers: { 'CJ-Access-Token': token } });
    const prods = (data.data?.list || data.data || []).map(p => ({
      pid: p.pid,
      nome: p.productNameEn || p.productName,
      sku: p.productSku,
      imagem: p.productImage,
      preco_cj: parseFloat(p.sellPrice) || 0,
      categoria: p.categoryName,
      peso: p.productWeight
    }));
    res.json(prods);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== Publicar produto no ML ====================

app.post('/api/publicar', async (req, res) => {
  try {
    const { pid, titulo, preco_brl, imagem, categoria_ml, quantidade } = req.body;
    const { data: tokenData } = await supabase.from('ml_tokens').select('access_token,user_id').limit(1).single();
    if (!tokenData) return res.status(400).json({ error: 'ML nao conectado. Clique em Conectar ML no dashboard.' });
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

// ==================== Dashboard ====================

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send('<h2>DropFacil Online. Acesse <a href="/api/cj/test">/api/cj/test</a></h2>');
  }
});

// ==================== CRON: sync pedidos a cada 15 min ====================

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

// ==================== CRON: renovar token ML a cada 5h ====================

cron.schedule('0 */5 * * *', async () => {
  try {
    const { data: row } = await supabase.from('ml_tokens').select('refresh_token,user_id').limit(1).single();
    if (!row?.refresh_token) return;
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: row.refresh_token
    }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    await supabase.from('ml_tokens').update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      updated_at: new Date().toISOString()
    }).eq('user_id', row.user_id);
    console.log('[CRON] Token ML renovado automaticamente');
  } catch (e) { console.error('[CRON refresh]', e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('DropFacil v3.0 porta ' + PORT));
