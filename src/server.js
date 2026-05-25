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

// ====== CJ TOKEN CACHE ======
let cjTokenCache = { token: null, expiresAt: 0 };
const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

async function getCjToken() {
  const now = Date.now();
  if (cjTokenCache.token && now < cjTokenCache.expiresAt) return cjTokenCache.token;
  const res = await axios.post(CJ_BASE + '/authentication/getAccessToken',
    { apiKey: process.env.CJ_API_KEY },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const token = res.data.data.accessToken;
  cjTokenCache = { token, expiresAt: now + 170 * 60 * 1000 };
  console.log('[CJ] Token renovado');
  return token;
}

// ====== ML TOKEN: get com auto-refresh ======
async function getMlToken() {
  const { data: row } = await supabase.from('ml_tokens').select('*').limit(1).single();
  if (!row) throw new Error('ML nao conectado. Clique em Conectar ML.');

  try {
    await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: 'Bearer ' + row.access_token }
    });
    return row.access_token;
  } catch (e) {
    if (!row.refresh_token) throw new Error('Token ML expirado e sem refresh_token. Reconecte o ML.');
    console.log('[ML] Token expirado, tentando refresh...');
    try {
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
      console.log('[ML] Token renovado via refresh para user_id:', row.user_id);
      return data.access_token;
    } catch (re) {
      throw new Error('Refresh ML falhou: ' + (re.response?.data?.message || re.message) + '. Reconecte o ML.');
    }
  }
}

// ====== Buscar categoria leaf para o produto ======
async function getCategoryId(titulo, accessToken) {
  try {
    const { data } = await axios.get(
      'https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=' +
      encodeURIComponent(titulo) + '&limit=3',
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (data && data[0] && data[0].category_id) {
      console.log('[ML] Categoria detectada:', data[0].category_id, 'para:', titulo.slice(0,50));
      return data[0].category_id;
    }
  } catch (e) {
    console.log('[ML] Falha ao detectar categoria:', e.message);
  }
  return 'MLB1648';
}

// ====== Publicar no ML com retry sem atributos ======
async function publicarNoML(listing, accessToken) {
  // Tentativa 1: com atributos
  try {
    const { data } = await axios.post('https://api.mercadolibre.com/items', listing, {
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
    });
    return data;
  } catch (e1) {
    const errBody = e1.response?.data;
    const causes = errBody?.cause || [];
    const errMsg = JSON.stringify(errBody).toLowerCase();

    // Se erro for de atributo invalido ou normalizable -> retry sem atributos
    const attrError = causes.some(c =>
      c.code === 'item.attributes.normalizable.invalid' ||
      c.code === 'item.attributes.missing_required' ||
      String(c.message || '').includes('attribute') ||
      String(c.message || '').includes('Attribute')
    );

    if (attrError) {
      console.log('[PUBLICAR] Erro de atributo, tentando sem atributos...');
      const listingSimples = Object.assign({}, listing);
      delete listingSimples.attributes;
      try {
        const { data: data2 } = await axios.post('https://api.mercadolibre.com/items', listingSimples, {
          headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
        });
        return data2;
      } catch (e2) {
        const errBody2 = e2.response?.data;
        const causes2 = errBody2?.cause || [];
        const leafError = causes2.some(c =>
          String(c.message || '').includes('leaf') ||
          c.code === 'item.category_id.invalid'
        );

        // Se erro for de categoria -> tenta categoria generica
        if (leafError || String(JSON.stringify(errBody2)).includes('leaf')) {
          console.log('[PUBLICAR] Erro de categoria, tentando MLB1648...');
          listingSimples.category_id = 'MLB1648';
          const { data: data3 } = await axios.post('https://api.mercadolibre.com/items', listingSimples, {
            headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
          });
          return data3;
        }
        throw e2;
      }
    }

    // Se erro for de categoria (leaf) -> tenta categoria generica
    const leafError = causes.some(c =>
      String(c.message || '').includes('leaf') ||
      c.code === 'item.category_id.invalid'
    );
    if (leafError || errMsg.includes('leaf')) {
      console.log('[PUBLICAR] Categoria nao-leaf, tentando MLB1648...');
      listing.category_id = 'MLB1648';
      delete listing.attributes;
      const { data: data4 } = await axios.post('https://api.mercadolibre.com/items', listing, {
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
      });
      return data4;
    }

    throw e1;
  }
}

// ====== OAuth Mercado Livre ======
app.get('/auth/mercadolivre', (req, res) => {
  const url = 'https://auth.mercadolivre.com.br/authorization?response_type=code' +
    '&client_id=' + process.env.ML_APP_ID +
    '&redirect_uri=' + encodeURIComponent(process.env.ML_REDIRECT_URI);
  res.redirect(url);
});

app.get('/callback', (req, res) => {
  const q = new URLSearchParams(req.query).toString();
  res.redirect('/auth/callback' + (q ? '?' + q : ''));
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
      expires_at: new Date(Date.now() + (data.expires_in || 21600) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    console.log('[ML OAuth] Token salvo para user_id:', data.user_id);
    res.redirect('/?ml=conectado');
  } catch (e) {
    console.error('[ML OAuth] Erro:', e.response?.data || e.message);
    res.redirect('/?erro=oauth_falhou&msg=' + encodeURIComponent(e.response?.data?.message || e.message));
  }
});

// ====== ML Status (com auto-refresh) ======
app.get('/api/ml/status', async (req, res) => {
  try {
    const { data: row } = await supabase.from('ml_tokens').select('*').limit(1).single();
    if (!row) return res.json({ conectado: false, erro: 'sem_token' });

    try {
      const { data: me } = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: 'Bearer ' + row.access_token }
      });
      return res.json({ conectado: true, user_id: String(me.id), nickname: me.nickname });
    } catch (te) {
      if (!row.refresh_token) return res.json({ conectado: false, user_id: row.user_id, erro: 'token_expirado_sem_refresh' });
      try {
        const { data: rd } = await axios.post('https://api.mercadolibre.com/oauth/token', {
          grant_type: 'refresh_token',
          client_id: process.env.ML_APP_ID,
          client_secret: process.env.ML_CLIENT_SECRET,
          refresh_token: row.refresh_token
        }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
        await supabase.from('ml_tokens').update({
          access_token: rd.access_token,
          refresh_token: rd.refresh_token,
          updated_at: new Date().toISOString()
        }).eq('user_id', row.user_id);
        const { data: me2 } = await axios.get('https://api.mercadolibre.com/users/me', {
          headers: { Authorization: 'Bearer ' + rd.access_token }
        });
        console.log('[ML Status] Token renovado automaticamente para:', me2.nickname);
        return res.json({ conectado: true, user_id: String(me2.id), nickname: me2.nickname });
      } catch (re) {
        return res.json({ conectado: false, user_id: row.user_id, erro: 'refresh_falhou' });
      }
    }
  } catch (e) {
    res.json({ conectado: false, erro: e.message });
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
    const token = await getMlToken();
    const me = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + token } });
    const r = await axios.get('https://api.mercadolibre.com/orders/search?seller=' + me.data.id + '&sort=date_desc&limit=50', {
      headers: { Authorization: 'Bearer ' + token }
    });
    let count = 0;
    for (const o of r.data.results || []) {
      await supabase.from('pedidos').upsert({
        ml_order_id: String(o.id),
        buyer_name: o.buyer?.nickname || 'Desconhecido',
        total: o.total_amount, status: o.status,
        ml_user_id: String(me.data.id), created_at: o.date_created
      }, { onConflict: 'ml_order_id' });
      count++;
    }
    res.json({ success: true, message: count + ' pedidos sincronizados' });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

// ====== Buscar produtos CJ ======
app.get('/api/buscar-produtos', async (req, res) => {
  try {
    const { q = '', page = 1, limit = 20, top } = req.query;
    const token = await getCjToken();
    const pageSize = Math.min(parseInt(limit) || 20, 50);

    let params;
    if (top && !q) {
      const cats = ['phone case', 'jewelry', 'led light', 'pet supplies', 'beauty', 'fitness', 'kitchen gadget', 'baby', 'watch', 'bag'];
      const cat = cats[Math.floor(Math.random() * cats.length)];
      params = { productName: cat, pageNum: 1, pageSize };
    } else if (q) {
      params = { productName: q, pageNum: parseInt(page), pageSize };
    } else {
      params = { pageNum: parseInt(page), pageSize };
    }

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
      peso: p.productWeight,
      busca: params.productName || null
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

    // Token com refresh automatico
    let accessToken, userId;
    try {
      accessToken = await getMlToken();
      const me = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      userId = String(me.data.id);
    } catch (tokenErr) {
      return res.status(400).json({ error: 'ML nao conectado. ' + tokenErr.message });
    }

    // Detectar categoria leaf
    const catId = categoria_ml || await getCategoryId(titulo, accessToken);

    const listing = {
      title: titulo,
      category_id: catId,
      price: preco_brl,
      currency_id: 'BRL',
      available_quantity: 1,
      buying_mode: 'buy_it_now',
      condition: 'new',
      listing_type_id: 'free',
      description: { plain_text: titulo + '\n\nProduto novo, qualidade garantida. Enviamos para todo o Brasil!' },
      pictures: [{ source: imagem }],
    };

    console.log('[PUBLICAR] Tentando:', JSON.stringify({ title: titulo.slice(0,40), category_id: catId, price: preco_brl }));

    const mlData = await publicarNoML(listing, accessToken);

    await supabase.from('produtos').upsert({
      ml_item_id: mlData.id,
      cj_pid: pid,
      titulo,
      preco_ml: preco_brl,
      imagem,
      status: 'active',
      ml_user_id: userId
    });

    console.log('[PUBLICAR] Sucesso!', mlData.id, mlData.permalink);
    res.json({ success: true, ml_id: mlData.id, permalink: mlData.permalink });

  } catch (e) {
    const errBody = e.response?.data;
    const msg = errBody?.message || errBody?.error || e.message;
    const causes = (errBody?.cause || []).map(c => c.message || c.code).join('; ');
    console.error('[PUBLICAR ERRO FINAL]', msg, causes || '');
    res.status(500).json({
      error: msg + (causes ? ' | ' + causes : ''),
      detail: errBody?.cause || null
    });
  }
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
    const token = await getMlToken();
    const me = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + token } });
    const r = await axios.get('https://api.mercadolibre.com/orders/search?seller=' + me.data.id + '&sort=date_desc&limit=50', {
      headers: { Authorization: 'Bearer ' + token }
    });
    for (const o of r.data.results || []) {
      await supabase.from('pedidos').upsert({
        ml_order_id: String(o.id),
        buyer_name: o.buyer?.nickname || 'Desconhecido',
        total: o.total_amount, status: o.status,
        ml_user_id: String(me.data.id), created_at: o.date_created
      }, { onConflict: 'ml_order_id' });
    }
    console.log('[CRON] Pedidos sincronizados:', r.data.results?.length || 0);
  } catch (e) { console.log('[CRON pedidos] ML nao conectado ou erro:', e.message); }
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
  console.log('DropFacil v5.3 porta ' + PORT);
  getCjToken().then(() => console.log('[INIT] Token CJ ok')).catch(e => console.error('[INIT CJ]', e.message));
});
