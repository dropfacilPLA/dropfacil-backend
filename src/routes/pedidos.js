const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// GET /api/pedidos - list all orders
router.get('/', async (req, res) => {
    try {
          const { data, error } = await supabase.from('pedidos').select('*').order('created_at', { ascending: false }).limit(100);
          if (error) throw error;
          res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pedidos/stats - order statistics
router.get('/stats', async (req, res) => {
    try {
          const { data, error } = await supabase.from('pedidos').select('status, total');
          if (error) throw error;
          const stats = {
                  total: data.length,
                  receita: data.reduce((sum, p) => sum + (parseFloat(p.total) || 0), 0),
                  pagos: data.filter(p => p.status === 'paid').length,
                  pendentes: data.filter(p => p.status === 'pending').length,
                  cancelados: data.filter(p => p.status === 'cancelled').length,
          };
          res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/pedidos/:id - update order status
router.put('/:id', async (req, res) => {
    try {
          const { data, error } = await supabase.from('pedidos').update(req.body).eq('id', req.params.id).select().single();
          if (error) throw error;
          res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
