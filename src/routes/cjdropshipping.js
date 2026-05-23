const express = require('express');
const axios = require('axios');
const router = express.Router();

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
let cjToken = null;
let cjTokenExpiry = null;

// Get CJ access token
async function getCJToken() {
    if (cjToken && cjTokenExpiry && Date.now() < cjTokenExpiry) return cjToken;
    const res = await axios.post(`${CJ_BASE}/authentication/getAccessToken`, {
          email: process.env.CJ_EMAIL,
          password: process.env.CJ_PASSWORD
    });
    if (res.data.result) {
          cjToken = res.data.data.accessToken;
          cjTokenExpiry = Date.now() + (res.data.data.expiresIn * 1000);
          return cjToken;
    }
    throw new Error('CJ auth failed: ' + res.data.message);
}

// GET /api/cj/search?q=produto - search products
router.get('/search', async (req, res) => {
    try {
          const token = await getCJToken();
          const { q, page = 1, pageSize = 20 } = req.query;
          const { data } = await axios.get(`${CJ_BASE}/product/list`, {
                  params: { productName: q, pageNum: page, pageSize },
                  headers: { 'CJ-Access-Token': token }
          });
          res.json(data.data || data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cj/produto/:id - product details
router.get('/produto/:id', async (req, res) => {
    try {
          const token = await getCJToken();
          const { data } = await axios.get(`${CJ_BASE}/product/query`, {
                  params: { pid: req.params.id },
                  headers: { 'CJ-Access-Token': token }
          });
          res.json(data.data || data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cj/mais-vendidos - hot selling products
router.get('/mais-vendidos', async (req, res) => {
    try {
          const token = await getCJToken();
          const { data } = await axios.get(`${CJ_BASE}/product/list`, {
                  params: {
                            pageNum: 1,
                            pageSize: 20,
                            productType: 'ORDINARY_PRODUCT',
                            categoryId: ''
                  },
                  headers: { 'CJ-Access-Token': token }
          });
          res.json(data.data?.list || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/cj/pedido - create CJ order
router.post('/pedido', async (req, res) => {
    try {
          const token = await getCJToken();
          const { orderNumber, shippingAddress, products } = req.body;
          const { data } = await axios.post(`${CJ_BASE}/shopping/order/createOrder`,
                                            { orderNumber, shippingAddress, products },
                                            { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
                                                );
          res.json(data);
    } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /api/cj/frete - calculate shipping
router.post('/frete', async (req, res) => {
    try {
          const token = await getCJToken();
          const { startCountryCode = 'CN', endCountryCode = 'BR', products } = req.body;
          const { data } = await axios.post(`${CJ_BASE}/logistic/freightCalculate`,
                                            { startCountryCode, endCountryCode, products },
                                            { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
                                                );
          res.json(data.data || data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
