const router = require('express').Router();
const { db, pool } = require('../db');
const { auth } = require('../auth');

router.use(auth);

// ─── HELPERS ────────────────────────────────────────────────
async function saldo(gid, clienteId) {
  const r = await db.one(
    `SELECT COALESCE(SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END),0) AS s FROM cobrancas WHERE grafica_id=$1 AND cliente_id=$2`,
    [gid, clienteId]
  );
  return parseFloat(r.s);
}

async function checarPlano(gid) {
  const g = await db.one('SELECT plano, plano_expira FROM graficas WHERE id=$1', [gid]);
  if (!g) return { ok: false, erro: 'Gráfica não encontrada' };
  if (g.plano_expira && new Date(g.plano_expira) < new Date()) return { ok: false, erro: 'Plano expirado. Contate o suporte.' };
  if (g.plano === 'gratuito') {
    const t = await db.one('SELECT COUNT(*) AS n FROM clientes WHERE grafica_id=$1', [gid]);
    if (parseInt(t.n) >= 20) return { ok: false, erro: 'Limite do plano gratuito: 20 clientes. Faça upgrade para Pro.' };
  }
  return { ok: true };
}

// ─── PAINEL ─────────────────────────────────────────────────
router.get('/painel', async (req, res) => {
  try {
    const gid = req.gid;
    const [totalCob, clientesCob, statusPed, matBaixo, entHoje, entAtras, cobAtras, ultPedidos, topCob] = await Promise.all([
      db.one(`SELECT COALESCE(SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END),0) AS t FROM cobrancas WHERE grafica_id=$1`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM (SELECT cliente_id FROM cobrancas WHERE grafica_id=$1 GROUP BY cliente_id HAVING SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END)>0) t`, [gid]),
      db(`SELECT status, COUNT(*) AS n FROM pedidos WHERE grafica_id=$1 GROUP BY status`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM materiais WHERE grafica_id=$1 AND quantidade<=qtd_minima`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM pedidos WHERE grafica_id=$1 AND data_entrega=CURRENT_DATE AND status!='entregue'`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM pedidos WHERE grafica_id=$1 AND data_entrega<CURRENT_DATE AND status NOT IN ('entregue','cancelado')`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM (SELECT cliente_id FROM cobrancas WHERE grafica_id=$1 AND tipo='debito' GROUP BY cliente_id HAVING SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END)>0 AND MAX(CASE WHEN tipo='debito' THEN data END)<=CURRENT_DATE-INTERVAL '30 days') t`, [gid]),
      db(`SELECT p.*,c.nome AS cnome,c.apelido AS capelido FROM pedidos p JOIN clientes c ON p.cliente_id=c.id WHERE p.grafica_id=$1 AND p.status NOT IN ('entregue','cancelado') ORDER BY p.data_entrega ASC NULLS LAST LIMIT 5`, [gid]),
      db(`SELECT c.id,c.nome,c.apelido,c.telefone,
          SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END) AS saldo,
          MAX(CASE WHEN cb.tipo='debito' THEN cb.data END) AS ultimo
          FROM cobrancas cb JOIN clientes c ON cb.cliente_id=c.id
          WHERE cb.grafica_id=$1 GROUP BY c.id
          HAVING SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END)>0
          ORDER BY SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END) DESC LIMIT 5`, [gid]),
    ]);
    const ps = {}; statusPed.forEach(r => ps[r.status] = parseInt(r.n));
    res.json({
      totalCob: parseFloat(totalCob.t),
      clientesCob: parseInt(clientesCob?.n || 0),
      statusPedidos: ps,
      matBaixo: parseInt(matBaixo.n),
      entHoje: parseInt(entHoje.n),
      entAtras: parseInt(entAtras.n),
      cobAtras: parseInt(cobAtras.n),
      ultPedidos,
      topCob,
    });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

// ─── CLIENTES ───────────────────────────────────────────────
router.get('/clientes', async (req, res) => {
  const { busca } = req.query; const gid = req.gid;
  let sql = `SELECT c.*, (SELECT COUNT(*) FROM pedidos WHERE cliente_id=c.id AND grafica_id=$1) AS total_pedidos FROM clientes c WHERE c.grafica_id=$1`;
  const p = [gid];
  if (busca) { sql += ` AND (c.nome ILIKE $2 OR c.apelido ILIKE $2 OR c.telefone ILIKE $2)`; p.push(`%${busca}%`); }
  sql += ' ORDER BY c.nome';
  const lista = await db(sql, p);
  const result = await Promise.all(lista.map(async c => ({ ...c, saldo: await saldo(gid, c.id) })));
  res.json(result);
});

router.get('/clientes/:id', async (req, res) => {
  const gid = req.gid;
  const c = await db.one('SELECT * FROM clientes WHERE id=$1 AND grafica_id=$2', [req.params.id, gid]);
  if (!c) return res.status(404).json({ erro: 'Não encontrado' });
  c.saldo = await saldo(gid, c.id);
  c.pedidos = await db('SELECT * FROM pedidos WHERE cliente_id=$1 AND grafica_id=$2 ORDER BY criado_em DESC', [c.id, gid]);
  res.json(c);
});

router.post('/clientes', async (req, res) => {
  const gid = req.gid;
  const plano = await checarPlano(gid);
  if (!plano.ok) return res.status(403).json({ erro: plano.erro });
  const { nome, apelido, telefone, instagram, endereco, observacoes } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  const c = await db.insert('INSERT INTO clientes (grafica_id,nome,apelido,telefone,instagram,endereco,observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7)', [gid, nome.trim(), apelido||'', telefone||'', instagram||'', endereco||'', observacoes||'']);
  res.json(c);
});

router.put('/clientes/:id', async (req, res) => {
  const { nome, apelido, telefone, instagram, endereco, observacoes } = req.body;
  await db('UPDATE clientes SET nome=$1,apelido=$2,telefone=$3,instagram=$4,endereco=$5,observacoes=$6 WHERE id=$7 AND grafica_id=$8', [nome, apelido||'', telefone||'', instagram||'', endereco||'', observacoes||'', req.params.id, req.gid]);
  res.json({ ok: true });
});

router.delete('/clientes/:id', async (req, res) => {
  await db('DELETE FROM clientes WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
  res.json({ ok: true });
});

// ─── PEDIDOS ────────────────────────────────────────────────
router.get('/pedidos', async (req, res) => {
  const { status, busca } = req.query; const gid = req.gid;
  let sql = `SELECT p.*,c.nome AS cnome,c.apelido AS capelido,c.telefone AS ctel FROM pedidos p JOIN clientes c ON p.cliente_id=c.id WHERE p.grafica_id=$1`;
  const p = [gid];
  if (status) { sql += ` AND p.status=$${p.length+1}`; p.push(status); }
  if (busca)  { sql += ` AND (p.descricao ILIKE $${p.length+1} OR c.nome ILIKE $${p.length+1})`; p.push(`%${busca}%`); }
  sql += ' ORDER BY p.data_entrega ASC NULLS LAST, p.criado_em DESC';
  res.json(await db(sql, p));
});

router.post('/pedidos', async (req, res) => {
  const gid = req.gid;
  const { cliente_id, descricao, tipo, quantidade, valor_total, valor_pago, status, data_pedido, data_entrega, observacoes } = req.body;
  if (!cliente_id || !descricao?.trim()) return res.status(400).json({ erro: 'Cliente e descrição obrigatórios' });
  const vt = parseFloat(valor_total)||0, vp = parseFloat(valor_pago)||0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [ped] } = await client.query(
      'INSERT INTO pedidos (grafica_id,cliente_id,descricao,tipo,quantidade,valor_total,valor_pago,status,data_pedido,data_entrega,observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [gid, cliente_id, descricao.trim(), tipo||'Outros', quantidade||1, vt, vp, status||'pendente', data_pedido||null, data_entrega||null, observacoes||'']
    );
    if (vt - vp > 0) {
      await client.query(
        `INSERT INTO cobrancas (grafica_id,cliente_id,pedido_id,tipo,valor,descricao,data) VALUES ($1,$2,$3,'debito',$4,$5,$6)`,
        [gid, cliente_id, ped.id, vt-vp, `Saldo: ${descricao}`, data_pedido || new Date().toISOString().split('T')[0]]
      );
    }
    await client.query('COMMIT');
    res.json(ped);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ erro: 'Erro ao salvar' }); }
  finally { client.release(); }
});

router.put('/pedidos/:id', async (req, res) => {
  const { descricao, tipo, quantidade, valor_total, valor_pago, status, data_pedido, data_entrega, observacoes } = req.body;
  await db('UPDATE pedidos SET descricao=$1,tipo=$2,quantidade=$3,valor_total=$4,valor_pago=$5,status=$6,data_pedido=$7,data_entrega=$8,observacoes=$9 WHERE id=$10 AND grafica_id=$11',
    [descricao, tipo, quantidade, valor_total, valor_pago, status, data_pedido||null, data_entrega||null, observacoes, req.params.id, req.gid]);
  res.json({ ok: true });
});

router.delete('/pedidos/:id', async (req, res) => {
  await db('DELETE FROM pedidos WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
  res.json({ ok: true });
});

// ─── COBRANÇAS ──────────────────────────────────────────────
router.get('/cobrancas', async (req, res) => {
  const gid = req.gid;
  res.json(await db(`
    SELECT c.id,c.nome,c.apelido,c.telefone,
      COALESCE(SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END),0) AS saldo,
      MAX(CASE WHEN cb.tipo='debito' THEN cb.data END) AS ultimo
    FROM clientes c
    LEFT JOIN cobrancas cb ON cb.cliente_id=c.id AND cb.grafica_id=$1
    WHERE c.grafica_id=$1
    GROUP BY c.id
    HAVING COALESCE(SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END),0) > 0
    ORDER BY COALESCE(SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END),0) DESC`, [gid]));
});

router.post('/cobrancas', async (req, res) => {
  const { cliente_id, tipo, valor, descricao, data } = req.body;
  if (!cliente_id || !valor) return res.status(400).json({ erro: 'Dados incompletos' });
  await db('INSERT INTO cobrancas (grafica_id,cliente_id,tipo,valor,descricao,data) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.gid, cliente_id, tipo||'debito', parseFloat(valor), descricao||'', data||new Date().toISOString().split('T')[0]]);
  res.json({ ok: true, saldo: await saldo(req.gid, cliente_id) });
});

router.get('/cobrancas/historico/:clienteId', async (req, res) => {
  res.json(await db(
    'SELECT cb.*,p.descricao AS pdesc FROM cobrancas cb LEFT JOIN pedidos p ON cb.pedido_id=p.id WHERE cb.cliente_id=$1 AND cb.grafica_id=$2 ORDER BY cb.data DESC,cb.criado_em DESC',
    [req.params.clienteId, req.gid]
  ));
});

// ─── MATERIAIS ──────────────────────────────────────────────
router.get('/materiais', async (req, res) => {
  const { busca } = req.query; const gid = req.gid;
  let sql = 'SELECT * FROM materiais WHERE grafica_id=$1'; const p = [gid];
  if (busca) { sql += ' AND (nome ILIKE $2 OR categoria ILIKE $2)'; p.push(`%${busca}%`); }
  sql += ' ORDER BY categoria,nome';
  res.json(await db(sql, p));
});

router.post('/materiais', async (req, res) => {
  const { nome, categoria, quantidade, unidade, qtd_minima } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  const m = await db.insert('INSERT INTO materiais (grafica_id,nome,categoria,quantidade,unidade,qtd_minima) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.gid, nome.trim(), categoria||'Geral', parseFloat(quantidade)||0, unidade||'un', parseFloat(qtd_minima)||0]);
  res.json(m);
});

router.put('/materiais/:id', async (req, res) => {
  const { nome, categoria, quantidade, unidade, qtd_minima } = req.body;
  await db('UPDATE materiais SET nome=$1,categoria=$2,quantidade=$3,unidade=$4,qtd_minima=$5 WHERE id=$6 AND grafica_id=$7',
    [nome, categoria, parseFloat(quantidade)||0, unidade, parseFloat(qtd_minima)||0, req.params.id, req.gid]);
  res.json({ ok: true });
});

router.delete('/materiais/:id', async (req, res) => {
  await db('DELETE FROM materiais WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
  res.json({ ok: true });
});

router.post('/materiais/:id/mov', async (req, res) => {
  const { tipo, quantidade, descricao } = req.body; const gid = req.gid;
  const mat = await db.one('SELECT * FROM materiais WHERE id=$1 AND grafica_id=$2', [req.params.id, gid]);
  if (!mat) return res.status(404).json({ erro: 'Não encontrado' });
  const qtd = parseFloat(quantidade);
  const nova = tipo === 'entrada' ? parseFloat(mat.quantidade)+qtd : Math.max(0, parseFloat(mat.quantidade)-qtd);
  await db('UPDATE materiais SET quantidade=$1 WHERE id=$2', [nova, mat.id]);
  res.json({ ok: true, quantidade: nova });
});

// ─── CONFIGURAÇÕES ──────────────────────────────────────────
router.get('/config', async (req, res) => {
  const g = await db.one('SELECT id,nome,email,plano,plano_expira FROM graficas WHERE id=$1', [req.gid]);
  res.json(g);
});

router.put('/config/nome', async (req, res) => {
  const { nome } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  await db('UPDATE graficas SET nome=$1 WHERE id=$2', [nome.trim(), req.gid]);
  res.json({ ok: true, nome: nome.trim() });
});

router.put('/config/senha', async (req, res) => {
  const { senha_atual, nova_senha } = req.body;
  if (!nova_senha || nova_senha.length < 6) return res.status(400).json({ erro: 'Nova senha muito curta' });
  const g = await db.one('SELECT senha_hash FROM graficas WHERE id=$1', [req.gid]);
  const ok = await require('bcryptjs').compare(senha_atual, g.senha_hash);
  if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta' });
  const hash = await require('bcryptjs').hash(nova_senha, 10);
  await db('UPDATE graficas SET senha_hash=$1 WHERE id=$2', [hash, req.gid]);
  res.json({ ok: true });
});

module.exports = router;
