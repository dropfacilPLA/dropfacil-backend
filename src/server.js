// DropFacil v5.6 - dropshipping 100% hands-free: frete me2 xd_drop_off + Bling nacional
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

// ====== Buscar categoria leaf ======
async function getCategoryId(titulo, accessToken) {
      try {
              const { data } = await axios.get(
                        'https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=' +
                        encodeURIComponent(titulo) + '&limit=1',
                  { headers: { Authorization: 'Bearer ' + accessToken } }
                      );
              if (data && data[0] && data[0].category_id) {
                        console.log('[ML] Categoria detectada:', data[0].category_id);
                        return data[0].category_id;
              }
      } catch (e) { console.log('[ML] Falha categoria:', e.message); }
      return null;
}

// ====== Buscar atributos obrigatorios ======
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
                                    attributes.push({ id: attr.id, value_id: attr.values[0].id });
                        } else if (attr.value_type === 'number_unit') {
                                    attributes.push({ id: attr.id, value_name: '40 cm' });
                        } else if (attr.value_type === 'boolean') {
                                    attributes.push({ id: attr.id, value_id: '242084' });
                        } else {
                                    attributes.push({ id: attr.id, value_name: 'Nao informado' });
                        }
              }
              return attributes;
      } catch (e) { return []; }
}

// ====== MODO DROPSHIPPING 100% HANDS-FREE ======
// xd_drop_off = cross-docking: o FORNECEDOR envia direto ao deposito ML
// ou o produto vai direto do CJ -> Correios -> cliente
// VOCE NAO TOCA NO PRODUTO EM NENHUM MOMENTO
async function publicarNoML(titulo, preco, imagem, accessToken, categoriaSugerida, quantidade, fonte) {
      const qtd = (quantidade && quantidade > 0) ? parseInt(quantidade) : 50;

  // SHIPPING HANDS-FREE:
  // me2 = Mercado Envios (obrigatorio para frete calculado automatico)
  // xd_drop_off = cross-docking: fornecedor despacha, voce nao ve o produto
  // Alternativa: 'drop_off' caso xd_drop_off seja rejeitado
  const shippingHandsFree = {
          mode: 'me2',
          local_pick_up: false,
          free_shipping: false,
          logistic_type: 'xd_drop_off'
  };

  // Fallback: drop_off (voce leva a agencia - nao ideal mas funciona)
  const shippingFallback = {
          mode: 'me2',
          local_pick_up: false,
          free_shipping: false,
          logistic_type: 'drop_off'
  };

  const descricao = fonte === 'bling'
        ? titulo + '\n\nProduto nacional. Envio pelo Mercado Envios. Entrega rapida para todo o Brasil. Produto novo e de qualidade garantida.'
          : titulo + '\n\nEnvio pelo Mercado Envios. Produto novo com qualidade garantida. Entrega para todo o Brasil.';

  const base = {
          price: preco,
          currency_id: 'BRL',
          available_quantity: qtd,
          buying_mode: 'buy_it_now',
          condition: 'new',
          listing_type_id: 'free',
          description: { plain_text: descricao },
          pictures: [{ source: imagem }],
  };

  const tentativas = [];

  if (categoriaSugerida) {
          const attrs = await buildAttributes(categoriaSugerida, accessToken);
          if (attrs.length > 0) {
                    tentativas.push({ title: titulo, ...base, category_id: categoriaSugerida, attributes: attrs, shipping: shippingHandsFree });
                    tentativas.push({ title: titulo, ...base, category_id: categoriaSugerida, attributes: attrs, shipping: shippingFallback });
          }
          tentativas.push({ title: titulo, ...base, category_id: categoriaSugerida, shipping: shippingHandsFree });
          tentativas.push({ title: titulo, ...base, category_id: categoriaSugerida, shipping: shippingFallback });
  }

  const catsFallback = ['MLB12456', 'MLB43794', 'MLB5726', 'MLB3937', 'MLB271599'];
      for (const cat of catsFallback) {
              tentativas.push({ title: titulo, ...base, category_id: cat, shipping: shippingHandsFree });
              tentativas.push({ title: titulo, ...base, category_id: cat, shipping: shippingFallback });
      }

  let lastError = null;
      for (const listing of tentativas) {
              try {
                        console.log('[PUBLICAR] cat:', listing.category_id, '| logistic:', listing.shipping.logistic_type, '| qtd:', listing.available_quantity);
                        const { data } = await axios.post('https://api.mercadolibre.com/items', listing, {
                                    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
                        });
                        console.log('[PUBLICAR OK]', data.id, '| status:', data.status, '| shipping:', data.shipping?.logistic_type);
                        return data;
              } catch (e) {
                        const errBody = e.response?.data;
                        const msgs = (errBody?.cause || []).map(c => c.message || c.code).join('; ');
                        console.log('[PUBLICAR FALHOU] cat:', listing.category_id, '-', errBody?.message || e.message, msgs);
                        lastError = e;
                        const status = e.response?.status;
                        if (status === 401 || status === 403) throw e;
              }
      }
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

// ====== ML Status ======
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
                                    return res.json({ conectado: true, user_id: String(me2.id), nickname: me2.nickname });
                        } catch (re) {
                                    return res.json({ conectado: false, user_id: row.user_id, erro: 'refresh_falhou' });
                        }
              }
      } catch (e) { res.json({ conectado: false, erro: e.message }); }
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

app.post('/api/ml/atualizar-estoque', async (req, res) => {
      try {
              const { ml_item_id, quantidade } = req.body;
              if (!ml_item_id || !quantidade) return res.status(400).json({ error: 'ml_item_id e quantidade obrigatorios' });
              const token = await getMlToken();
              const { data } = await axios.put(
                        'https://api.mercadolibre.com/items/' + ml_item_id,
                  { available_quantity: parseInt(quantidade) },
                  { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }
                      );
              res.json({ success: true, item: data.id, quantidade: data.available_quantity });
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
                        params, headers: { 'CJ-Access-Token': token }
              });
              const list = data.data?.list || data.data || [];
              const prods = list.map(p => ({
                        pid: p.pid, nome: p.productNameEn || p.productName,
                        sku: p.productSku, imagem: p.productImage,
                        preco_cj: parseFloat(p.sellPrice) || 0,
                        categoria: p.categoryName, peso: p.productWeight,
                        busca: params.productName || null, fonte: 'cj'
              }));
              res.json(prods);
      } catch (e) {
              if (e.response?.status === 401) cjTokenCache = { token: null, expiresAt: 0 };
              res.status(500).json({ error: e.message });
      }
});

// ====== BLING: Buscar produtos nacionais ======
// Bling e um ERP brasileiro com API REST gratuita para pequenos lojistas
// Produtos nacionais = entrega em 2-5 dias uteis (vs 15-30 dias do CJ)
// O fornecedor despacha direto pelo Mercado Envios — voce nao toca no produto
app.get('/api/bling/produtos', async (req, res) => {
      try {
              const blingKey = process.env.BLING_API_KEY;
              if (!blingKey) return res.json({ error: 'BLING_API_KEY nao configurada', produtos: [], instrucoes: 'Crie conta gratis em bling.com.br e gere uma API Key nas configuracoes' });

        const { q = '', page = 1 } = req.query;
              // Bling API v3
        const { data } = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
                  headers: { Authorization: 'Bearer ' + blingKey },
                  params: { pagina: parseInt(page), limite: 20, criterio: 1, tipo: 'P', nome: q || undefined }
        });

        const produtos = (data.data || []).map(p => ({
                  pid: String(p.id),
                  nome: p.nome,
                  sku: p.codigo,
                  imagem: p.imagemURL || (p.imagens && p.imagens[0]?.link) || '',
                  preco_cj: parseFloat(p.preco) || 0,
                  preco_brl: parseFloat(p.precoVenda) || parseFloat(p.preco) || 0,
                  categoria: p.tipo || 'Nacional',
                  peso: p.pesoBruto,
                  estoque: p.estoque?.saldoVirtualTotal || 0,
                  fonte: 'bling'
        }));
              res.json(produtos);
      } catch (e) {
              res.status(500).json({ error: e.response?.data?.error?.message || e.message, produtos: [] });
      }
});

// ====== BLING: Status da conexao ======
app.get('/api/bling/status', async (req, res) => {
      const blingKey = process.env.BLING_API_KEY;
      if (!blingKey) return res.json({ conectado: false, msg: 'API Key nao configurada' });
      try {
              const { data } = await axios.get('https://www.bling.com.br/Api/v3/usuarios/me', {
                        headers: { Authorization: 'Bearer ' + blingKey }
              });
              res.json({ conectado: true, nome: data.data?.nome || 'Bling conectado' });
      } catch (e) {
              res.json({ conectado: false, msg: e.response?.data?.error?.message || e.message });
      }
});

// ====== Publicar produto no ML (CJ ou Bling) ======
app.post('/api/publicar', async (req, res) => {
      try {
              const { pid, titulo, preco_brl, imagem, categoria_ml, quantidade, fonte } = req.body;
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
              const catSugerida = categoria_ml || await getCategoryId(titulo, accessToken);
              const mlData = await publicarNoML(titulo, preco_brl, imagem, accessToken, catSugerida, quantidade, fonte || 'cj');
              await supabase.from('produtos').upsert({
                        ml_item_id: mlData.id, cj_pid: pid, titulo,
                        preco_ml: preco_brl, imagem, status: 'active',
                        ml_user_id: userId, fonte: fonte || 'cj'
              });
              console.log('[PUBLICAR OK] Item:', mlData.id, '| Permalink:', mlData.permalink);
              res.json({ success: true, ml_id: mlData.id, permalink: mlData.permalink, logistic_type: mlData.shipping?.logistic_type });
      } catch (e) {
              const errBody = e.response?.data;
              const msg = errBody?.message || errBody?.error || e.message;
              const causes = (errBody?.cause || []).map(c => c.message || c.code).join('; ');
              console.error('[PUBLICAR ERRO FINAL]', msg, causes || '');
              res.status(500).json({ error: msg + (causes ? ' | ' + causes : ''), detail: errBody?.cause || null });
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
              console.log('[CRON] Pedidos sync:', r.data.results?.length || 0);
      } catch (e) { console.log('[CRON pedidos] erro:', e.message); }
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
              console.log('[CRON] Token ML renovado');
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
      console.log('DropFacil v5.6 porta ' + PORT);
      getCjToken().then(() => console.log('[INIT] Token CJ ok')).catch(e => console.error('[INIT CJ]', e.message));
});
