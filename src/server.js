// DropFacil v5.7 - AUTOMACAO TOTAL: ML venda -> CJ pedido automatico -> entrega ao cliente
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
// Rota legada: /api/publicar -> redireciona para /api/ml/anuncio
app.post('/api/publicar', (req, res) => { req.url = '/anuncio'; require('./routes/mercadolivre')(req, res); });
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

// ====== ML TOKEN ======
async function getMlToken() {
  const { data: row } = await supabase.from('ml_tokens').select('*').limit(1).single();
  if (!row) throw new Error('ML nao conectado.');
  try {
    await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + row.access_token } });
    return row.access_token;
  } catch (e) {
    if (!row.refresh_token) throw new Error('Token ML expirado. Reconecte o ML.');
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'refresh_token', client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET, refresh_token: row.refresh_token
    }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    await supabase.from('ml_tokens').update({
      access_token: data.access_token, refresh_token: data.refresh_token,
      updated_at: new Date().toISOString()
    }).eq('user_id', row.user_id);
    return data.access_token;
  }
}

// ====== BUSCAR CATEGORIA ======
async function getCategoryId(titulo, accessToken) {
  try {
    const { data } = await axios.get(
      'https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=' + encodeURIComponent(titulo) + '&limit=1',
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (data && data[0] && data[0].category_id) return data[0].category_id;
  } catch (e) {}
  return null;
}

// ====== BUSCAR ATRIBUTOS ======
async function buildAttributes(categoryId, accessToken) {
  try {
    const { data } = await axios.get('https://api.mercadolibre.com/categories/' + categoryId + '/attributes',
      { headers: { Authorization: 'Bearer ' + accessToken } });
    const required = (data || []).filter(a => a.tags && (a.tags.required || a.tags.buy_box_winner));
    return required.map(attr => {
      if (attr.value_type === 'list' && attr.values?.length) return { id: attr.id, value_id: attr.values[0].id };
      if (attr.value_type === 'boolean') return { id: attr.id, value_id: '242084' };
      return { id: attr.id, value_name: 'Nao informado' };
    });
  } catch (e) { return []; }
}

// ====== PUBLICAR NO ML ======
async function publicarNoML(titulo, preco, imagem, accessToken, categoriaSugerida, quantidade) {
  const qtd = (quantidade && quantidade > 0) ? parseInt(quantidade) : 50;
  const shipping = { mode: 'me2', local_pick_up: false, free_shipping: false, logistic_type: 'xd_drop_off' };
  const shippingFallback = { mode: 'me2', local_pick_up: false, free_shipping: false, logistic_type: 'drop_off' };
  const base = {
    price: preco, currency_id: 'BRL', available_quantity: qtd,
    buying_mode: 'buy_it_now', condition: 'new', listing_type_id: 'free',
    description: { plain_text: titulo + '\n\nEnvio pelo Mercado Envios. Produto novo e de qualidade. Entrega rapida para todo o Brasil.' },
    pictures: [{ source: imagem }]
  };
  const tentativas = [];
  if (categoriaSugerida) {
    const attrs = await buildAttributes(categoriaSugerida, accessToken);
    if (attrs.length) {
      tentativas.push({ title: titulo, ...base, category_id: categoriaSugerida, attributes: attrs, shipping });
      tentativas.push({ title: titulo, ...base, category_id: categoriaSugerida, attributes: attrs, shipping: shippingFallback });
    }
    tentativas.push({ title: titulo, ...base, category_id: categoriaSugerida, shipping });
    tentativas.push({ title: titulo, ...base, category_id: categoriaSugerida, shipping: shippingFallback });
  }
  for (const cat of ['MLB12456', 'MLB43794', 'MLB5726', 'MLB3937']) {
    tentativas.push({ title: titulo, ...base, category_id: cat, shipping });
    tentativas.push({ title: titulo, ...base, category_id: cat, shipping: shippingFallback });
  }
  let lastError = null;
  for (const listing of tentativas) {
    try {
      const { data } = await axios.post('https://api.mercadolibre.com/items', listing,
        { headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' } });
      console.log('[ML] Publicado:', data.id, '| logistic:', data.shipping?.logistic_type);
      return data;
    } catch (e) {
      lastError = e;
      if (e.response?.status === 401 || e.response?.status === 403) throw e;
    }
  }
  throw lastError;
}

// ============================================================
// AUTOMACAO TOTAL: quando ML tem venda paga -> pede no CJ
// ============================================================
async function fazerPedidoCJ(pedidoML, produtoDB, cjToken) {
  // Buscar endereco completo do comprador via API ML
  const mlToken = await getMlToken();
  const orderId = pedidoML.ml_order_id;

  // Buscar detalhes do pedido ML (inclui endereco de entrega)
  let orderDetails;
  try {
    const { data } = await axios.get('https://api.mercadolibre.com/orders/' + orderId,
      { headers: { Authorization: 'Bearer ' + mlToken } });
    orderDetails = data;
  } catch (e) {
    console.error('[AUTO-PEDIDO] Erro ao buscar pedido ML:', e.message);
    throw e;
  }

  // Extrair endereco do comprador
  const shipping = orderDetails.shipping;
  let endereco;
  try {
    const { data: shippingData } = await axios.get('https://api.mercadolibre.com/shipments/' + shipping.id,
      { headers: { Authorization: 'Bearer ' + mlToken } });
    const dest = shippingData.receiver_address;
    endereco = {
      nome: dest.receiver_name || orderDetails.buyer.nickname,
      telefone: dest.receiver_phone || '11999999999',
      cep: dest.zip_code.replace(/\D/g, ''),
      rua: dest.street_name,
      numero: dest.street_number || 'SN',
      complemento: dest.comment || '',
      bairro: dest.neighborhood?.name || '',
      cidade: dest.city?.name || '',
      estado: dest.state?.name || '',
      pais: 'BR'
    };
  } catch (e) {
    console.error('[AUTO-PEDIDO] Erro ao buscar endereco shipment:', e.message);
    throw new Error('Nao foi possivel obter endereco de entrega: ' + e.message);
  }

  // Buscar SKU do produto no CJ para confirmar
  const cjPid = produtoDB.cj_pid;
  if (!cjPid) throw new Error('Produto sem cj_pid - nao pode pedir automaticamente');

  // Criar pedido no CJ
  const pedidoCJ = {
    orderNumber: 'ML-' + orderId,
    shippingCountry: 'BR',
    shippingCustomerName: endereco.nome,
    shippingPhone: endereco.telefone,
    shippingAddress: endereco.rua + ', ' + endereco.numero + (endereco.complemento ? ' ' + endereco.complemento : ''),
    shippingAddress2: endereco.bairro,
    shippingCity: endereco.cidade,
    shippingProvince: endereco.estado,
    shippingZip: endereco.cep,
    products: [{
      vid: cjPid,
      quantity: 1,
      price: produtoDB.preco_ml || 0
    }],
    logisticName: 'CJPacket Ordinary Brazil',
    remark: 'Pedido automatico DropFacil ML#' + orderId
  };

  try {
    const { data } = await axios.post(CJ_BASE + '/order/createOrder', pedidoCJ,
      { headers: { 'CJ-Access-Token': cjToken, 'Content-Type': 'application/json' } });
    if (data.result) {
      console.log('[AUTO-PEDIDO] CJ OK! orderId:', data.data?.orderId, '| ML:', orderId);
      return { cj_order_id: data.data?.orderId, status: 'pedido_cj_ok' };
    } else {
      throw new Error('CJ recusou pedido: ' + (data.message || JSON.stringify(data)));
    }
  } catch (e) {
    console.error('[AUTO-PEDIDO] Erro CJ:', e.response?.data || e.message);
    throw e;
  }
}

// ====== CRON: Auto-pedido CJ a cada 15 min ======
// Fluxo: ML pago -> busca endereco -> pede no CJ -> CJ envia direto ao cliente
async function processarPedidosAutomaticos() {
  try {
    const mlToken = await getMlToken();
    const cjToken = await getCjToken();
    const { data: me } = await axios.get('https://api.mercadolibre.com/users/me',
      { headers: { Authorization: 'Bearer ' + mlToken } });

    // Buscar pedidos pagos ML dos ultimos 7 dias
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: ordersData } = await axios.get(
      'https://api.mercadolibre.com/orders/search?seller=' + me.id +
      '&order.status=paid&sort=date_desc&limit=20&order.date_created.from=' + since,
      { headers: { Authorization: 'Bearer ' + mlToken } }
    );

    const pedidosML = ordersData.results || [];
    let processados = 0, erros = 0;

    for (const order of pedidosML) {
      const orderId = String(order.id);
      // Verificar se ja foi processado
      const { data: existing } = await supabase.from('pedidos')
        .select('cj_order_id, auto_status').eq('ml_order_id', orderId).single();

      if (existing?.cj_order_id) {
        // Ja tem pedido CJ, pular
        continue;
      }

      // Salvar/atualizar pedido ML no banco
      await supabase.from('pedidos').upsert({
        ml_order_id: orderId,
        buyer_name: order.buyer?.nickname || 'Comprador',
        total: order.total_amount,
        status: order.status,
        ml_user_id: String(me.id),
        created_at: order.date_created,
        auto_status: 'pendente'
      }, { onConflict: 'ml_order_id' });

      // Buscar produto correspondente no banco pelo ml_item_id
      const mlItemId = order.order_items?.[0]?.item?.id;
      if (!mlItemId) { console.log('[AUTO-PEDIDO] Sem item no pedido ML:', orderId); continue; }

      const { data: produtoDB } = await supabase.from('produtos')
        .select('*').eq('ml_item_id', mlItemId).single();

      if (!produtoDB?.cj_pid) {
        console.log('[AUTO-PEDIDO] Produto nao encontrado para item:', mlItemId, '| Pedido:', orderId);
        await supabase.from('pedidos').update({ auto_status: 'sem_produto_cj' }).eq('ml_order_id', orderId);
        continue;
      }

      // Fazer pedido automatico no CJ
      try {
        const resultado = await fazerPedidoCJ({ ml_order_id: orderId }, produtoDB, cjToken);
        await supabase.from('pedidos').update({
          cj_order_id: resultado.cj_order_id,
          auto_status: 'pedido_cj_ok',
          auto_at: new Date().toISOString()
        }).eq('ml_order_id', orderId);
        processados++;
        console.log('[AUTO] Pedido automatico feito! ML:', orderId, '-> CJ:', resultado.cj_order_id);
        // Esperar 2s entre pedidos para nao sobrecarregar API
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        erros++;
        await supabase.from('pedidos').update({
          auto_status: 'erro_cj: ' + e.message.substring(0, 100),
          auto_at: new Date().toISOString()
        }).eq('ml_order_id', orderId);
        console.error('[AUTO] Erro no pedido automatico ML:', orderId, '->', e.message);
      }
    }

    if (processados > 0 || erros > 0) {
      console.log('[AUTO CRON] Processados:', processados, '| Erros:', erros);
    }
  } catch (e) {
    if (!e.message.includes('nao conectado')) {
      console.error('[AUTO CRON] Erro geral:', e.message);
    }
  }
}

// ====== OAuth ML ======
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
      grant_type: 'authorization_code', client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET, code, redirect_uri: process.env.ML_REDIRECT_URI
    }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    await supabase.from('ml_tokens').upsert({
      user_id: String(data.user_id), access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + (data.expires_in || 21600) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    res.redirect('/?ml=conectado');
  } catch (e) {
    res.redirect('/?erro=oauth_falhou&msg=' + encodeURIComponent(e.response?.data?.message || e.message));
  }
});

// ====== ML Status ======
app.get('/api/ml/status', async (req, res) => {
  try {
    const { data: row } = await supabase.from('ml_tokens').select('*').limit(1).single();
    if (!row) return res.json({ conectado: false, erro: 'sem_token' });
    try {
      const { data: me } = await axios.get('https://api.mercadolibre.com/users/me',
        { headers: { Authorization: 'Bearer ' + row.access_token } });
      return res.json({ conectado: true, user_id: String(me.id), nickname: me.nickname });
    } catch {
      if (!row.refresh_token) return res.json({ conectado: false, erro: 'token_expirado' });
      try {
        const { data: rd } = await axios.post('https://api.mercadolibre.com/oauth/token', {
          grant_type: 'refresh_token', client_id: process.env.ML_APP_ID,
          client_secret: process.env.ML_CLIENT_SECRET, refresh_token: row.refresh_token
        }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
        await supabase.from('ml_tokens').update({
          access_token: rd.access_token, refresh_token: rd.refresh_token,
          updated_at: new Date().toISOString()
        }).eq('user_id', row.user_id);
        const { data: me2 } = await axios.get('https://api.mercadolibre.com/users/me',
          { headers: { Authorization: 'Bearer ' + rd.access_token } });
        return res.json({ conectado: true, user_id: String(me2.id), nickname: me2.nickname });
      } catch {
        return res.json({ conectado: false, erro: 'refresh_falhou' });
      }
    }
  } catch (e) { res.json({ conectado: false, erro: e.message }); }
});

app.post('/api/ml/sync-orders', async (req, res) => {
  try {
    const token = await getMlToken();
    const me = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + token } });
    const r = await axios.get('https://api.mercadolibre.com/orders/search?seller=' + me.data.id + '&sort=date_desc&limit=50',
      { headers: { Authorization: 'Bearer ' + token } });
    for (const o of r.data.results || []) {
      await supabase.from('pedidos').upsert({
        ml_order_id: String(o.id), buyer_name: o.buyer?.nickname || 'Desconhecido',
        total: o.total_amount, status: o.status,
        ml_user_id: String(me.data.id), created_at: o.date_created
      }, { onConflict: 'ml_order_id' });
    }
    res.json({ success: true, message: r.data.results?.length + ' pedidos sincronizados' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Pedido automatico manual (forcar) ======
app.post('/api/auto-pedido/forcar', async (req, res) => {
  try {
    const { ml_order_id } = req.body;
    if (!ml_order_id) return res.status(400).json({ error: 'ml_order_id obrigatorio' });
    const { data: pedido } = await supabase.from('pedidos').select('*').eq('ml_order_id', ml_order_id).single();
    if (!pedido) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const mlItemId = pedido.ml_item_id;
    const { data: produto } = await supabase.from('produtos').select('*').eq('ml_item_id', mlItemId).maybeSingle();
    if (!produto?.cj_pid) return res.status(400).json({ error: 'Produto sem cj_pid mapeado' });
    const cjToken = await getCjToken();
    const resultado = await fazerPedidoCJ(pedido, produto, cjToken);
    await supabase.from('pedidos').update({
      cj_order_id: resultado.cj_order_id, auto_status: 'pedido_cj_ok',
      auto_at: new Date().toISOString()
    }).eq('ml_order_id', ml_order_id);
    res.json({ success: true, cj_order_id: resultado.cj_order_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Status do pedido CJ ======
app.get('/api/auto-pedido/status/:cj_order_id', async (req, res) => {
  try {
    const cjToken = await getCjToken();
    const { data } = await axios.get(CJ_BASE + '/order/getOrderDetail?orderId=' + req.params.cj_order_id,
      { headers: { 'CJ-Access-Token': cjToken } });
    res.json({ success: true, order: data.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      params = { productName: cats[Math.floor(Math.random() * cats.length)], pageNum: 1, pageSize };
    } else {
      params = { productName: q || '', pageNum: parseInt(page), pageSize };
    }
    const { data } = await axios.get(CJ_BASE + '/product/list', { params, headers: { 'CJ-Access-Token': token } });
    const list = data.data?.list || data.data || [];
    res.json(list.map(p => ({
      pid: p.pid, nome: p.productNameEn || p.productName,
      sku: p.productSku, imagem: p.productImage,
      preco_cj: parseFloat(p.sellPrice) || 0,
      categoria: p.categoryName, peso: p.productWeight,
      busca: params.productName, fonte: 'cj'
    })));
  } catch (e) {
    if (e.response?.status === 401) cjTokenCache = { token: null, expiresAt: 0 };
    res.status(500).json({ error: e.message });
  }
});

// ====== Publicar produto no ML ======
app.post('/api/publicar', async (req, res) => {
  try {
    const { pid, titulo, preco_brl, imagem, categoria_ml, quantidade } = req.body;
    let accessToken, userId;
    try {
      accessToken = await getMlToken();
      const me = await axios.get('https://api.mercadolibre.com/users/me',
        { headers: { Authorization: 'Bearer ' + accessToken } });
      userId = String(me.data.id);
    } catch (e) { return res.status(400).json({ error: 'ML nao conectado: ' + e.message }); }
    const catSugerida = categoria_ml || await getCategoryId(titulo, accessToken);
    const mlData = await publicarNoML(titulo, preco_brl, imagem, accessToken, catSugerida, quantidade);
    await supabase.from('produtos').upsert({
      ml_item_id: mlData.id, cj_pid: pid, titulo,
      preco_ml: preco_brl, imagem, status: 'active', ml_user_id: userId
    });
    res.json({ success: true, ml_id: mlData.id, permalink: mlData.permalink });
  } catch (e) {
    const errBody = e.response?.data;
    const msg = errBody?.message || e.message;
    const causes = (errBody?.cause || []).map(c => c.message || c.code).join('; ');
    res.status(500).json({ error: msg + (causes ? ' | ' + causes : ''), detail: errBody?.cause || null });
  }
});

// ====== Dashboard ======
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
  else res.send('<h2>DropFacil v5.7 Online</h2>');
});

// ====== CRON: Auto-pedido CJ a cada 15 min ======
cron.schedule('*/15 * * * *', async () => {
  console.log('[CRON] Verificando pedidos para auto-compra no CJ...');
  await processarPedidosAutomaticos();
});

// ====== CRON: Renovar token ML a cada 5h ======
cron.schedule('0 */5 * * *', async () => {
  try {
    const { data: row } = await supabase.from('ml_tokens').select('refresh_token,user_id').limit(1).single();
    if (!row?.refresh_token) return;
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'refresh_token', client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET, refresh_token: row.refresh_token
    }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    await supabase.from('ml_tokens').update({
      access_token: data.access_token, refresh_token: data.refresh_token,
      updated_at: new Date().toISOString()
    }).eq('user_id', row.user_id);
    console.log('[CRON] Token ML renovado');
  } catch (e) { console.error('[CRON refresh ML]', e.message); }
});

// ====== CRON: Pre-aquecer CJ a cada 2h ======
cron.schedule('0 */2 * * *', async () => {
  try { await getCjToken(); } catch (e) {}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('DropFacil v5.7 porta ' + PORT + ' | Automacao: ML->CJ automatico ativo');
  getCjToken().then(() => console.log('[INIT] CJ ok')).catch(e => console.error('[INIT CJ]', e.message));
});
