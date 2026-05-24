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

app.use(express.static(path.join(__dirname, 'public')));

// ====== CJ TOKEN CACHE (evita re-autenticar a cada request) ======
let cjTokenCache = { token: null, expiresAt: 0 };
const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

async function getCjToken() {
  const now = Date.now();
  if (cjTokenCache.token && now < cjTokenCache.expiresAt) {
    return cjTokenCache.token;
  }
  const res = await axios.post(CJ_BASE + '/authentication/getAccessToken',
    { apiKey: process.env.CJ_API_KEY },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const token = res.data.data.accessToken;
  cjTokenCache = { token, expiresAt: now + 170 * 60 * 1000 }; // cache 170 min
  console.log('[CJ] Token renovado, expira em 170min');
  return token;
}

// ====== OAuth Mercado Livre ======
app.get('/auth/mercadolivre', (req, res) => {
  const url = 'https://auth.mercadolivre.com.br/authorization?response_type=code' +
    '&client_id=' + process.env.ML_APP_ID +
    '&redirect_uri=' + encodeURIComponent(process.env.ML_REDIRECT_URI);
  res.redirect(url);
});

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
    res.redirect('/?erro=oauth_falhou&msg=' + encodeURIComponent(e.response?.data?.message || e.message));
  }
});

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

// ====== Buscar produtos CJ (com cache de token) ======
app.get('/api/buscar-produtos', async (req, res) => {
  try {
    const { q = '', page = 1, limit = 20 } = req.query;
    const token = await getCjToken();
    const pageSize = Math.min(parseInt(limit) || 20, 50);
    const params = q
      ? { productName: q, pageNum: parseInt(page), pageSize }
      : { pageNum: parseInt(page), pageSize };
    const { data } = await axios.get(CJ_BASE + '/product/list', {
      params,
      headers: { 'CJ-Access-Token': token }
    });
    const list = data.data?.list || data.data || [];
    const prods = list.map(p => ({
      pid: p.pid,
      nome: p.productNameEn || p.productName,
      sku: p.productSku,
      imagem: p.productImage,
      preco_cj: parseFloat(p.sellPrice) || 0,
      categoria: p.categoryName,
      peso: p.productWeight
    }));
    res.json(prods);
  } catch (e) {
    if (e.response?.status === 401) cjTokenCache = { token: null, expiresAt: 0 };
    res.status(500).json({ error: e.message });
  }
});

// ====== Publicar produto no ML ======
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

// ====== Dashboard HTML ======
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
  else res.send('<h2>DropFacil Online.</h2>');
});

// ====== CRON: sync pedidos a cada 15 min ======
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
  } catch (e) { console.error('[CRON pedidos]', e.message); }
});

// ====== CRON: renovar token ML a cada 5h ======
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
  } catch (e) { console.error('[CRON refresh ML]', e.message); }
});

// ====== CRON: pre-aquecer token CJ a cada 2h ======
cron.schedule('0 */2 * * *', async () => {
  try {
    await getCjToken();
    console.log('[CRON] Token CJ pre-aquecido');
  } catch (e) { console.error('[CRON CJ token]', e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('DropFacil v4.0 porta ' + PORT);
  // Pre-aquecer token CJ na inicializacao
  getCjToken().then(() => console.log('[INIT] Token CJ pre-aquecido')).catch(e => console.error('[INIT CJ]', e.message));
});
