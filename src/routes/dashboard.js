const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// GET /api/dashboard - full dashboard stats
router.get('/', async (req, res) => {
    try {
          const [pedidosRes, produtosRes] = await Promise.all([
                  supabase.from('pedidos').select('status, total, created_at'),
                  supabase.from('produtos').select('id, status, price')
                ]);
          const pedidos = pedidosRes.data || [];
          const produtos = produtosRes.data || [];
          const hoje = new Date();
          const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
          const pedidosMes = pedidos.filter(p => new Date(p.created_at) >= inicioMes);
          res.json({
                  pedidos: {
                            total: pedidos.length,
                            este_mes: pedidosMes.length,
                            receita_total: pedidos.reduce((s, p) => s + (parseFloat(p.total) || 0), 0),
                            receita_mes: pedidosMes.reduce((s, p) => s + (parseFloat(p.total) || 0), 0),
                            pagos: pedidos.filter(p => p.status === 'paid').length,
                            pendentes: pedidos.filter(p => p.status === 'pending').length,
                  },
                  produtos: {
                            total: produtos.length,
                            ativos: produtos.filter(p => p.status === 'active').length,
                  },
                  status: 'online',
                  ultima_atualizacao: new Date().toISOString()
          });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
