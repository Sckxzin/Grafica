const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { token, authAdmin } = require('../auth');

function ip(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '?';
}

// Setup do primeiro admin
router.post('/setup', async (req, res) => {
  try {
    const { nome, email, senha, setup_key } = req.body;
    const esperada = (process.env.ADMIN_SETUP_KEY || '').trim();
    const recebida = (setup_key || '').trim();
    console.log(`[SETUP] esperada="${esperada}" recebida="${recebida}"`);
    if (!esperada) return res.status(500).json({ erro: 'ADMIN_SETUP_KEY não configurada' });
    if (recebida !== esperada) return res.status(403).json({ erro: 'Chave inválida' });
    const total = await db.one('SELECT COUNT(*) AS n FROM admins');
    if (parseInt(total.n) > 0) return res.status(400).json({ erro: 'Admin já existe' });
    if (!nome || !email || !senha || senha.length < 6) return res.status(400).json({ erro: 'Dados incompletos' });
    const hash = await bcrypt.hash(senha, 10);
    const a = await db.insert('INSERT INTO admins (nome,email,senha_hash) VALUES ($1,$2,$3)', [nome, email.toLowerCase(), hash]);
    res.json({ ok: true, admin: { id: a.id, nome: a.nome, email: a.email } });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

// Login admin
router.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const a = await db.one('SELECT * FROM admins WHERE email=$1', [email?.toLowerCase()]);
    if (!a || !(await bcrypt.compare(senha, a.senha_hash))) return res.status(401).json({ erro: 'Credenciais inválidas' });
    await db(`INSERT INTO logs (admin_id,tipo,descricao,ip) VALUES ($1,'admin_login','Admin logou',$2)`, [a.id, ip(req)]);
    res.json({ token: token({ id: a.id, nome: a.nome, email: a.email, role: 'admin' }, '8h'), admin: { id: a.id, nome: a.nome, email: a.email } });
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

// Dashboard
router.get('/dashboard', authAdmin, async (req, res) => {
  try {
    const [total, ativos, bloqueados, planos, recentes, logs] = await Promise.all([
      db.one('SELECT COUNT(*) AS n FROM graficas'),
      db.one('SELECT COUNT(*) AS n FROM graficas WHERE ativo=true'),
      db.one('SELECT COUNT(*) AS n FROM graficas WHERE ativo=false'),
      db('SELECT plano, COUNT(*) AS n FROM graficas GROUP BY plano'),
      db('SELECT id,nome,email,plano,plano_expira,ativo,ultimo_acesso,criado_em FROM graficas ORDER BY criado_em DESC LIMIT 6'),
      db('SELECT l.*,g.nome AS grafica_nome FROM logs l LEFT JOIN graficas g ON l.grafica_id=g.id ORDER BY l.criado_em DESC LIMIT 25'),
    ]);
    res.json({ total: parseInt(total.n), ativos: parseInt(ativos.n), bloqueados: parseInt(bloqueados.n), planos, recentes, logs });
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

// Listar gráficas
router.get('/graficas', authAdmin, async (req, res) => {
  const { busca } = req.query;
  let sql = `SELECT g.*, (SELECT COUNT(*) FROM clientes WHERE grafica_id=g.id) AS clientes, (SELECT COUNT(*) FROM pedidos WHERE grafica_id=g.id) AS pedidos FROM graficas g`;
  const p = [];
  if (busca) { sql += ' WHERE g.nome ILIKE $1 OR g.email ILIKE $1'; p.push(`%${busca}%`); }
  sql += ' ORDER BY g.criado_em DESC';
  res.json(await db(sql, p));
});

// Detalhes de uma gráfica
router.get('/graficas/:id', authAdmin, async (req, res) => {
  const g = await db.one('SELECT * FROM graficas WHERE id=$1', [req.params.id]);
  if (!g) return res.status(404).json({ erro: 'Não encontrado' });
  g.clientes = (await db.one('SELECT COUNT(*) AS n FROM clientes WHERE grafica_id=$1', [g.id])).n;
  g.pedidos  = (await db.one('SELECT COUNT(*) AS n FROM pedidos WHERE grafica_id=$1', [g.id])).n;
  g.logs     = await db('SELECT * FROM logs WHERE grafica_id=$1 ORDER BY criado_em DESC LIMIT 30', [g.id]);
  res.json(g);
});

// Bloquear
router.patch('/graficas/:id/bloquear', authAdmin, async (req, res) => {
  const { motivo } = req.body;
  await db('UPDATE graficas SET ativo=false,motivo_bloqueio=$1 WHERE id=$2', [motivo || 'Bloqueado pelo admin', req.params.id]);
  await db(`INSERT INTO logs (grafica_id,admin_id,tipo,descricao,ip) VALUES ($1,$2,'bloqueio',$3,$4)`, [req.params.id, req.admin.id, `Bloqueado: ${motivo}`, ip(req)]);
  res.json({ ok: true });
});

// Desbloquear
router.patch('/graficas/:id/desbloquear', authAdmin, async (req, res) => {
  await db('UPDATE graficas SET ativo=true,motivo_bloqueio=NULL WHERE id=$1', [req.params.id]);
  await db(`INSERT INTO logs (grafica_id,admin_id,tipo,descricao,ip) VALUES ($1,$2,'desbloqueio','Acesso restaurado',$3)`, [req.params.id, req.admin.id, ip(req)]);
  res.json({ ok: true });
});

// Alterar plano
router.patch('/graficas/:id/plano', authAdmin, async (req, res) => {
  const { plano, plano_expira } = req.body;
  await db('UPDATE graficas SET plano=$1,plano_expira=$2 WHERE id=$3', [plano, plano_expira || null, req.params.id]);
  await db(`INSERT INTO logs (grafica_id,admin_id,tipo,descricao,ip) VALUES ($1,$2,'plano',$3,$4)`, [req.params.id, req.admin.id, `Plano → ${plano}`, ip(req)]);
  res.json({ ok: true });
});

// Resetar senha
router.patch('/graficas/:id/senha', authAdmin, async (req, res) => {
  const { nova_senha } = req.body;
  if (!nova_senha || nova_senha.length < 6) return res.status(400).json({ erro: 'Senha muito curta' });
  const hash = await bcrypt.hash(nova_senha, 10);
  await db('UPDATE graficas SET senha_hash=$1 WHERE id=$2', [hash, req.params.id]);
  await db(`INSERT INTO logs (grafica_id,admin_id,tipo,descricao,ip) VALUES ($1,$2,'reset_senha','Senha resetada',$3)`, [req.params.id, req.admin.id, ip(req)]);
  res.json({ ok: true });
});

// Excluir gráfica
router.delete('/graficas/:id', authAdmin, async (req, res) => {
  const g = await db.one('SELECT nome FROM graficas WHERE id=$1', [req.params.id]);
  await db('DELETE FROM graficas WHERE id=$1', [req.params.id]);
  await db(`INSERT INTO logs (admin_id,tipo,descricao,ip) VALUES ($1,'exclusao',$2,$3)`, [req.admin.id, `Excluída: ${g?.nome}`, ip(req)]);
  res.json({ ok: true });
});

module.exports = router;
