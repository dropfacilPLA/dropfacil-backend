const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// GET /api/produtos - list all products
router.get('/', async (req, res) => {
    try {
          const { data, error } = await supabase.from('produtos').select('*').order('created_at', { ascending: false });
          if (error) throw error;
          res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/produtos - add product
router.post('/', async (req, res) => {
    try {
          const { data, error } = await supabase.from('produtos').insert(req.body).select().single();
          if (error) throw error;
          res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/produtos/:id - update product
router.put('/:id', async (req, res) => {
    try {
          const { data, error } = await supabase.from('produtos').update(req.body).eq('id', req.params.id).select().single();
          if (error) throw error;
          res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/produtos/:id - delete product
router.delete('/:id', async (req, res) => {
    try {
          const { error } = await supabase.from('produtos').delete().eq('id', req.params.id);
          if (error) throw error;
          res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
