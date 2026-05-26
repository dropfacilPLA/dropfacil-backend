// DropFacil v5.4 - deploy final
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
      encodeURIComponent(titulo) + '&limit=1',
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (data && data[0] && data[0].category_id) {
      console.log('[ML] Categoria detectada:', data[0].category_id, 'para:', titulo.slice(0,50));
      return data[0].category_id;
    }
  } catch (e) {
    console.log('[ML] Falha ao detectar categoria:', e.message);
  }
  return null; // sem categoria detectada
}

// ====== Buscar atributos obrigatorios e montar valores padrão ======
async function buildAttributes(categoryId, accessToken) {
  try {
    const { data } = await axios.get(
      'https://api.mercadolibre.com/categories/' + categoryId + '/attributes',
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    const required = (data || []).filter(a => a.tags && (a.tags.required || a.tags.buy_box_winner));
    const attributes = [];
    for (const attr of required) {
      if (attr.value_type === 'list' && attr.values && attr.values.length > 0) {
        // Usar primeiro valor da lista
        attributes.push({ id: attr.id, value_id: attr.values[0].id });
      } else if (attr.value_type === 'number_unit') {
        // Valor numerico: usar "40 cm" como padrao
        attributes.push({ id: attr.id, value_name: '40 cm' });
      } else if (attr.value_type === 'boolean') {
        attributes.push({ id: attr.id, value_id: '242084' }); // "Nao"
      } else {
        // String: usar "Nao informado"
        attributes.push({ id: attr.id, value_name: 'Nao informado' });
      }
    }
    console.log('[ML] Atributos montados para', categoryId, ':', attributes.map(a => a.id).join(', '));
    return attributes;
  } catch (e) {
    console.log('[ML] Erro ao buscar atributos:', e.message);
    return [];
  }
}

// ====== Tentar publicar no ML com multiplos fallbacks ======
async function publicarNoML(titulo, preco, imagem, accessToken, categoriaSugerida, quantidade) {
  const qtd = (quantidade && quantidade > 0) ? quantidade : 1;
  const baseListagem = {
    price: preco,
    currency_id: 'BRL',
    available_quantity: qtd,
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: 'free',
    shipping: {
      mode: 'me2',
      local_pick_up: false,
      free_shipping: false,
      methods: [],
      dimensions: null
    },
    description: { plain_text: titulo + '\n\nEnvio pelo Mercado Envios. Produto novo com qualidade garantida.' },
    pictures: [{ source: imagem }],
  };

  // Tentativas em ordem de preferencia
  const tentativas = [];

  if (categoriaSugerida) {
    // Tentativa 1: categoria detectada com atributos
    const attrs = await buildAttributes(categoriaSugerida, accessToken);
    if (attrs.length > 0) {
      tentativas.push({ title: titulo, ...baseListagem, category_id: categoriaSugerida, attributes: attrs });
    }
    // Tentativa 2: categoria detectada sem atributos
    tentativas.push({ title: titulo, ...baseListagem, category_id: categoriaSugerida });
  }

  // Tentativa 3: categoria Outros - Esportes e Fitness (MLB198237 sem attrs, ou outra)
  // Tentativa 4: Outros - Utilidades Domesticas (MLB12456 - leaf)
  const catsFallback = ['MLB12456', 'MLB43794', 'MLB5726', 'MLB3937'];
  for (const cat of catsFallback) {
    tentativas.push({ title: titulo, ...baseListagem, category_id: cat });
  }

  let lastError = null;
  for (const listing of tentativas) {
    try {
      console.log('[PUBLICAR] Tentando cat:', listing.category_id, attrs_count = listing.attributes?.length || 0, 'attrs');
      const { data } = await axios.post('https://api.mercadolibre.com/items', listing, {
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
      });
      console.log('[PUBLICAR] Sucesso com cat:', listing.category_id);
      return data;
    } catch (e) {
      const errBody = e.response?.data;
      const causes = errBody?.cause || [];
      const msgs = causes.map(c => (c.message || c.code || '')).join('; ');
      console.log('[PUBLICAR] Falhou cat:', listing.category_id, '-', errBody?.message || e.message, msgs);
      lastError = e;

      // Parar se erro nao for de validacao/categoria (ex: auth error)
      const status = e.response?.status;
      if (status === 401 || status === 403) throw e;
    }
  }

  // Todos falharam
  throw lastError;
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

    // Detectar categoria
    const catSugerida = categoria_ml || await getCategoryId(titulo, accessToken);

    // Publicar com fallbacks automaticos
    const mlData = await publicarNoML(titulo, preco_brl, imagem, accessToken, catSugerida, quantidade);

    await supabase.from('produtos').upsert({
      ml_item_id: mlData.id,
      cj_pid: pid,
      titulo,
      preco_ml: preco_brl,
      imagem,
      status: 'active',
      ml_user_id: userId
    });

    console.log('[PUBLICAR] Item criado:', mlData.id, mlData.permalink);
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
  console.log('DropFacil v5.4 porta ' + PORT);
  getCjToken().then(() => console.log('[INIT] Token CJ ok')).catch(e => console.error('[INIT CJ]', e.message));
});
