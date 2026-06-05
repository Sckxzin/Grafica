const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { token, auth } = require('../auth');

const ip = req => req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '?';

async function bloqueado(email, ipAddr) {
  const r = await db.one(`SELECT COUNT(*) AS n FROM tentativas WHERE email=$1 AND ip=$2 AND ok=false AND criado_em>NOW()-INTERVAL '15 minutes'`, [email, ipAddr]);
  return parseInt(r.n) >= 5;
}

router.post('/cadastro', async (req, res) => {
  try {
    const { nome, email, senha } = req.body;
    if (!nome?.trim() || !email?.trim() || !senha) return res.status(400).json({ erro: 'Preencha todos os campos' });
    if (senha.length < 6) return res.status(400).json({ erro: 'Senha mínimo 6 caracteres' });
    if (await db.one('SELECT id FROM graficas WHERE email=$1', [email.toLowerCase()])) return res.status(400).json({ erro: 'E-mail já cadastrado' });
    const hash = await bcrypt.hash(senha, 10);
    const g = await db.insert('INSERT INTO graficas (nome,email,senha_hash) VALUES ($1,$2,$3)', [nome.trim(), email.toLowerCase(), hash]);
    await db(`INSERT INTO logs (grafica_id,tipo,descricao,ip) VALUES ($1,'cadastro','Nova conta',$2)`, [g.id, ip(req)]);
    res.json({ token: token({ id: g.id, nome: g.nome, email: g.email, plano: g.plano, role: 'grafica' }), grafica: { id: g.id, nome: g.nome, email: g.email, plano: g.plano } });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const ipAddr = ip(req);
    if (!email || !senha) return res.status(400).json({ erro: 'Preencha e-mail e senha' });
    if (await bloqueado(email.toLowerCase(), ipAddr)) { await db('INSERT INTO tentativas (email,ip,ok) VALUES ($1,$2,false)', [email.toLowerCase(), ipAddr]); return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' }); }
    const g = await db.one('SELECT * FROM graficas WHERE email=$1', [email.toLowerCase()]);
    if (!g || !(await bcrypt.compare(senha, g.senha_hash))) { await db('INSERT INTO tentativas (email,ip,ok) VALUES ($1,$2,false)', [email.toLowerCase(), ipAddr]); return res.status(401).json({ erro: 'E-mail ou senha incorretos' }); }
    if (!g.ativo) return res.status(403).json({ erro: g.motivo_bloqueio ? `Bloqueado: ${g.motivo_bloqueio}` : 'Acesso bloqueado.' });
    await db('INSERT INTO tentativas (email,ip,ok) VALUES ($1,$2,true)', [email.toLowerCase(), ipAddr]);
    await db('UPDATE graficas SET ultimo_acesso=NOW() WHERE id=$1', [g.id]);
    await db(`INSERT INTO logs (grafica_id,tipo,descricao,ip) VALUES ($1,'login','Login',$2)`, [g.id, ipAddr]);
    res.json({ token: token({ id: g.id, nome: g.nome, email: g.email, plano: g.plano, role: 'grafica' }), grafica: { id: g.id, nome: g.nome, email: g.email, plano: g.plano, plano_expira: g.plano_expira } });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/me', auth, async (req, res) => {
  const g = await db.one('SELECT id,nome,email,plano,plano_expira,ativo FROM graficas WHERE id=$1', [req.gid]);
  if (!g) return res.status(404).json({ erro: 'Não encontrado' });
  res.json({ grafica: g });
});

module.exports = router;
