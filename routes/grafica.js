const router = require('express').Router();
const { db, pool } = require('../db');
const { auth } = require('../auth');
const { orcamentoPdf } = require('../pdf');

router.use(auth);

// ─── HELPERS ────────────────────────────────────────────────
async function saldo(gid, clienteId) {
  const r = await db.one(
    `SELECT COALESCE(SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END),0) AS s
     FROM cobrancas WHERE grafica_id=$1 AND cliente_id=$2`,
    [gid, clienteId]
  );
  return parseFloat(r.s);
}

async function checarPlano(gid) {
  const g = await db.one('SELECT plano, plano_expira FROM graficas WHERE id=$1', [gid]);
  if (!g) return { ok: false, erro: 'Gráfica não encontrada' };
  if (g.plano_expira && new Date(g.plano_expira) < new Date()) return { ok: false, erro: 'Plano expirado. Contate o suporte.' };
  if (g.plano === 'vitalicio') return { ok: true };
  if (g.plano === 'gratuito') {
    const t = await db.one('SELECT COUNT(*) AS n FROM clientes WHERE grafica_id=$1', [gid]);
    if (parseInt(t.n) >= 20) return { ok: false, erro: 'Limite do plano gratuito: 20 clientes. Faça upgrade.' };
  }
  return { ok: true };
}

// Planos e recursos
const PLANOS = {
  gratuito: { clientes: 20, caixa: false, relBasico: false, relAvancado: false, meta: false, csv: false, agenda: false },
  pro:      { clientes: -1, caixa: true,  relBasico: true,  relAvancado: false, meta: false, csv: false, agenda: true  },
  premium:  { clientes: -1, caixa: true,  relBasico: true,  relAvancado: true,  meta: true,  csv: true,  agenda: true  },
  vitalicio:{ clientes: -1, caixa: true,  relBasico: true,  relAvancado: true,  meta: true,  csv: true,  agenda: true  },
};

function getPlano(plano) { return PLANOS[plano] || PLANOS.gratuito; }

async function authRecurso(recurso) {
  return async (req, res, next) => {
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [req.gid]);
    const p = getPlano(g.plano);
    if (!p[recurso]) return res.status(403).json({ erro: 'Recurso não disponível no seu plano.', plano: g.plano, recurso });
    req.plano = g.plano;
    next();
  };
}

const authCaixa     = authRecurso('caixa');
const authRelBasico = authRecurso('relBasico');
const authRelAvanc  = authRecurso('relAvancado');
const authMeta      = authRecurso('meta');
const authCsv       = authRecurso('csv');
const authAgenda    = authRecurso('agenda');

// ─── PAINEL ─────────────────────────────────────────────────
router.get('/painel', async (req, res) => {
  try {
    const gid = req.gid;
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [gid]);
    const pl = getPlano(g.plano);
    const [totalCob, clientesCob, statusPed, matBaixo, entHoje, entAtras, cobAtras, ultPedidos, topCob, saldoCaixa, aniversarios, entAmanha, orcPendentes] = await Promise.all([
      db.one(`SELECT COALESCE(SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END),0) AS t FROM cobrancas WHERE grafica_id=$1`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM (SELECT cliente_id FROM cobrancas WHERE grafica_id=$1 GROUP BY cliente_id HAVING SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END)>0) t`, [gid]),
      db(`SELECT status, COUNT(*) AS n FROM pedidos WHERE grafica_id=$1 GROUP BY status`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM materiais WHERE grafica_id=$1 AND quantidade<=qtd_minima`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM pedidos WHERE grafica_id=$1 AND data_entrega=CURRENT_DATE AND status!='entregue'`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM pedidos WHERE grafica_id=$1 AND data_entrega<CURRENT_DATE AND status NOT IN ('entregue','cancelado')`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM (SELECT cliente_id FROM cobrancas WHERE grafica_id=$1 AND tipo='debito' GROUP BY cliente_id HAVING SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END)>0 AND MAX(CASE WHEN tipo='debito' THEN data END)<=CURRENT_DATE-INTERVAL '30 days') t`, [gid]),
      db(`SELECT p.*,c.nome AS cnome,c.apelido AS capelido FROM pedidos p JOIN clientes c ON p.cliente_id=c.id WHERE p.grafica_id=$1 AND p.status NOT IN ('entregue','cancelado') ORDER BY p.data_entrega ASC NULLS LAST LIMIT 5`, [gid]),
      db(`SELECT c.id,c.nome,c.apelido,c.telefone, SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END) AS saldo, MAX(CASE WHEN cb.tipo='debito' THEN cb.data END) AS ultimo FROM cobrancas cb JOIN clientes c ON cb.cliente_id=c.id WHERE cb.grafica_id=$1 GROUP BY c.id HAVING SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END)>0 ORDER BY SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END) DESC LIMIT 5`, [gid]),
      pl.caixa ? db.one(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor ELSE -valor END),0) AS s FROM caixa WHERE grafica_id=$1 AND DATE_TRUNC('month',data)=DATE_TRUNC('month',CURRENT_DATE)`, [gid]) : { s: 0 },
      db(`SELECT nome,apelido FROM clientes WHERE grafica_id=$1 AND aniversario IS NOT NULL AND EXTRACT(MONTH FROM aniversario)=EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(DAY FROM aniversario)=EXTRACT(DAY FROM CURRENT_DATE)`, [gid]),
      db(`SELECT p.*,c.nome AS cnome,c.apelido AS capelido,c.telefone AS ctel FROM pedidos p JOIN clientes c ON p.cliente_id=c.id WHERE p.grafica_id=$1 AND p.data_entrega=CURRENT_DATE+1 AND p.status NOT IN ('entregue','cancelado')`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM orcamentos WHERE grafica_id=$1 AND status='pendente'`, [gid]),
    ]);
    const ps = {}; statusPed.forEach(r => ps[r.status] = parseInt(r.n));
    res.json({ totalCob: parseFloat(totalCob.t), clientesCob: parseInt(clientesCob?.n||0), statusPedidos: ps, matBaixo: parseInt(matBaixo.n), entHoje: parseInt(entHoje.n), entAtras: parseInt(entAtras.n), cobAtras: parseInt(cobAtras.n), ultPedidos, topCob, saldoCaixa: parseFloat(saldoCaixa.s), aniversarios, entAmanha, orcPendentes: parseInt(orcPendentes.n), plano: g.plano, recursos: pl });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

// ─── RELATÓRIOS BÁSICOS ─────────────────────────────────────
router.get('/relatorios', async (req, res) => {
  try {
    const gid = req.gid;
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [gid]);
    if (!getPlano(g.plano).relBasico) return res.status(403).json({ erro: 'Disponível nos planos Pro, Premium e Vitalício.' });
    const [fat, fatAnt, recebido, pendente, ticket, porTipo, topCli, pedStatus, novosClientes, inadimplencia] = await Promise.all([
      db.one(`SELECT COALESCE(SUM(valor_total),0) AS t FROM pedidos WHERE grafica_id=$1 AND DATE_TRUNC('month',criado_em)=DATE_TRUNC('month',NOW()) AND status!='cancelado'`, [gid]),
      db.one(`SELECT COALESCE(SUM(valor_total),0) AS t FROM pedidos WHERE grafica_id=$1 AND DATE_TRUNC('month',criado_em)=DATE_TRUNC('month',NOW()-INTERVAL '1 month') AND status!='cancelado'`, [gid]),
      db.one(`SELECT COALESCE(SUM(valor_pago),0) AS t FROM pedidos WHERE grafica_id=$1 AND DATE_TRUNC('month',criado_em)=DATE_TRUNC('month',NOW())`, [gid]),
      db.one(`SELECT COALESCE(SUM(valor_total-valor_pago),0) AS t FROM pedidos WHERE grafica_id=$1 AND DATE_TRUNC('month',criado_em)=DATE_TRUNC('month',NOW()) AND status!='cancelado'`, [gid]),
      db.one(`SELECT COALESCE(AVG(valor_total),0) AS t FROM pedidos WHERE grafica_id=$1 AND DATE_TRUNC('month',criado_em)=DATE_TRUNC('month',NOW()) AND status!='cancelado'`, [gid]),
      db(`SELECT tipo, COUNT(*) AS n, COALESCE(SUM(valor_total),0) AS total FROM pedidos WHERE grafica_id=$1 AND DATE_TRUNC('month',criado_em)=DATE_TRUNC('month',NOW()) AND status!='cancelado' GROUP BY tipo ORDER BY total DESC`, [gid]),
      db(`SELECT c.nome,c.apelido,COUNT(p.id) AS pedidos,COALESCE(SUM(p.valor_total),0) AS total FROM pedidos p JOIN clientes c ON p.cliente_id=c.id WHERE p.grafica_id=$1 AND p.status!='cancelado' GROUP BY c.id,c.nome,c.apelido ORDER BY total DESC LIMIT 5`, [gid]),
      db(`SELECT status, COUNT(*) AS n FROM pedidos WHERE grafica_id=$1 GROUP BY status`, [gid]),
      db.one(`SELECT COUNT(*) AS n FROM clientes WHERE grafica_id=$1 AND DATE_TRUNC('month',criado_em)=DATE_TRUNC('month',NOW())`, [gid]),
      db.one(`SELECT COUNT(*) AS total, SUM(CASE WHEN valor_pago<valor_total THEN 1 ELSE 0 END) AS inadimplentes FROM pedidos WHERE grafica_id=$1 AND DATE_TRUNC('month',criado_em)=DATE_TRUNC('month',NOW()) AND status!='cancelado'`, [gid]),
    ]);
    res.json({ faturamentoMes: parseFloat(fat.t), faturamentoMesAnterior: parseFloat(fatAnt.t), totalRecebido: parseFloat(recebido.t), totalPendente: parseFloat(pendente.t), ticketMedio: parseFloat(ticket.t), porTipo, topClientes: topCli, pedidosPorStatus: pedStatus, novosClientes: parseInt(novosClientes.n), inadimplencia: { total: parseInt(inadimplencia.total), inadimplentes: parseInt(inadimplencia.inadimplentes) } });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

// ─── RELATÓRIOS AVANÇADOS — comparativos ────────────────────
router.get('/relatorios/avancado', async (req, res) => {
  try {
    const gid = req.gid;
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [gid]);
    if (!getPlano(g.plano).relAvancado) return res.status(403).json({ erro: 'Disponível nos planos Premium e Vitalício.', upgrade: true });

    const [mesMes, porTipoEvol, clientesNovos, diasSemana, tempoMedio, clientesFreq] = await Promise.all([
      // Faturamento últimos 6 meses
      db(`SELECT TO_CHAR(DATE_TRUNC('month',criado_em),'YYYY-MM') AS mes,
          COALESCE(SUM(valor_total),0) AS faturamento,
          COALESCE(SUM(valor_pago),0) AS recebido,
          COUNT(*) AS pedidos
          FROM pedidos WHERE grafica_id=$1 AND criado_em>=NOW()-INTERVAL '6 months' AND status!='cancelado'
          GROUP BY DATE_TRUNC('month',criado_em) ORDER BY mes`, [gid]),
      // Evolução por tipo nos últimos 3 meses
      db(`SELECT TO_CHAR(DATE_TRUNC('month',criado_em),'YYYY-MM') AS mes, tipo,
          COUNT(*) AS n, COALESCE(SUM(valor_total),0) AS total
          FROM pedidos WHERE grafica_id=$1 AND criado_em>=NOW()-INTERVAL '3 months' AND status!='cancelado'
          GROUP BY DATE_TRUNC('month',criado_em), tipo ORDER BY mes, total DESC`, [gid]),
      // Clientes novos por mês (últimos 6 meses)
      db(`SELECT TO_CHAR(DATE_TRUNC('month',criado_em),'YYYY-MM') AS mes, COUNT(*) AS n
          FROM clientes WHERE grafica_id=$1 AND criado_em>=NOW()-INTERVAL '6 months'
          GROUP BY DATE_TRUNC('month',criado_em) ORDER BY mes`, [gid]),
      // Pedidos por dia da semana
      db(`SELECT EXTRACT(DOW FROM criado_em) AS dow, TO_CHAR(criado_em,'Day') AS dia,
          COUNT(*) AS pedidos, COALESCE(SUM(valor_total),0) AS faturamento
          FROM pedidos WHERE grafica_id=$1 AND status!='cancelado' AND criado_em>=NOW()-INTERVAL '3 months'
          GROUP BY EXTRACT(DOW FROM criado_em), TO_CHAR(criado_em,'Day') ORDER BY dow`, [gid]),
      // Tempo médio de produção (pedido → entrega)
      db.one(`SELECT COALESCE(AVG(data_entrega - data_pedido),0) AS media_dias
              FROM pedidos WHERE grafica_id=$1 AND status='entregue' AND data_pedido IS NOT NULL AND data_entrega IS NOT NULL`, [gid]),
      // Clientes que mais voltam
      db(`SELECT c.nome,c.apelido,COUNT(p.id) AS total_pedidos,
          COALESCE(SUM(p.valor_total),0) AS total_gasto,
          MAX(p.criado_em) AS ultimo_pedido
          FROM pedidos p JOIN clientes c ON p.cliente_id=c.id
          WHERE p.grafica_id=$1 AND p.status!='cancelado'
          GROUP BY c.id,c.nome,c.apelido HAVING COUNT(p.id)>1
          ORDER BY total_pedidos DESC, total_gasto DESC LIMIT 8`, [gid]),
    ]);

    res.json({ mesMes, porTipoEvol, clientesNovos, diasSemana, tempoMedioDias: parseFloat(tempoMedio.media_dias)||0, clientesFrequentes: clientesFreq });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

// ─── META MENSAL ─────────────────────────────────────────────
router.get('/meta', async (req, res) => {
  try {
    const gid = req.gid;
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [gid]);
    if (!getPlano(g.plano).meta) return res.status(403).json({ erro: 'Disponível nos planos Premium e Vitalício.', upgrade: true });
    const mes = req.query.mes || new Date().toISOString().slice(0,7);
    const meta = await db.one(`SELECT * FROM metas WHERE grafica_id=$1 AND mes=$2`, [gid, mes]).catch(() => null);
    const atual = await db.one(`SELECT COALESCE(SUM(valor_total),0) AS t FROM pedidos WHERE grafica_id=$1 AND TO_CHAR(criado_em,'YYYY-MM')=$2 AND status!='cancelado'`, [gid, mes]);
    res.json({ meta: meta || null, atual: parseFloat(atual.t), mes });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/meta', async (req, res) => {
  try {
    const gid = req.gid;
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [gid]);
    if (!getPlano(g.plano).meta) return res.status(403).json({ erro: 'Disponível nos planos Premium e Vitalício.' });
    const { mes, valor_meta } = req.body;
    if (!mes || !valor_meta) return res.status(400).json({ erro: 'Mês e valor obrigatórios' });
    await db(`INSERT INTO metas (grafica_id,mes,valor_meta) VALUES ($1,$2,$3)
              ON CONFLICT (grafica_id,mes) DO UPDATE SET valor_meta=$3`, [gid, mes, parseFloat(valor_meta)]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

// ─── EXPORTAR CSV ────────────────────────────────────────────
router.get('/exportar/pedidos', async (req, res) => {
  try {
    const gid = req.gid;
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [gid]);
    if (!getPlano(g.plano).csv) return res.status(403).json({ erro: 'Disponível nos planos Premium e Vitalício.' });
    const pedidos = await db(`SELECT p.descricao,p.tipo,p.quantidade,p.valor_total,p.valor_pago,p.status,p.data_pedido,p.data_entrega,p.observacoes,c.nome AS cliente,c.telefone FROM pedidos p JOIN clientes c ON p.cliente_id=c.id WHERE p.grafica_id=$1 ORDER BY p.criado_em DESC`, [gid]);
    const header = 'Descrição,Tipo,Qtd,Valor Total,Valor Pago,Status,Data Pedido,Data Entrega,Observações,Cliente,Telefone\n';
    const rows = pedidos.map(p => `"${p.descricao}","${p.tipo}",${p.quantidade},${p.valor_total},${p.valor_pago},"${p.status}","${p.data_pedido||''}","${p.data_entrega||''}","${p.observacoes||''}","${p.cliente}","${p.telefone||''}"`).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pedidos.csv"');
    res.send('\uFEFF' + header + rows);
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/exportar/clientes', async (req, res) => {
  try {
    const gid = req.gid;
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [gid]);
    if (!getPlano(g.plano).csv) return res.status(403).json({ erro: 'Disponível nos planos Premium e Vitalício.' });
    const clientes = await db(`SELECT c.nome,c.apelido,c.telefone,c.instagram,c.endereco,c.aniversario,c.observacoes,
        COUNT(p.id) AS total_pedidos, COALESCE(SUM(p.valor_total),0) AS total_gasto,
        COALESCE((SELECT SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END) FROM cobrancas WHERE cliente_id=c.id AND grafica_id=$1),0) AS saldo
        FROM clientes c LEFT JOIN pedidos p ON p.cliente_id=c.id AND p.grafica_id=$1
        WHERE c.grafica_id=$1 GROUP BY c.id ORDER BY c.nome`, [gid]);
    const header = 'Nome,Apelido,Telefone,Instagram,Endereço,Aniversário,Observações,Total Pedidos,Total Gasto,Saldo\n';
    const rows = clientes.map(c => `"${c.nome}","${c.apelido||''}","${c.telefone||''}","${c.instagram||''}","${c.endereco||''}","${c.aniversario||''}","${c.observacoes||''}",${c.total_pedidos},${c.total_gasto},${c.saldo}`).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
    res.send('\uFEFF' + header + rows);
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

// ─── AGENDA ─────────────────────────────────────────────────
router.get('/agenda', async (req, res) => {
  try {
    const gid = req.gid;
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [gid]);
    if (!getPlano(g.plano).agenda) return res.status(403).json({ erro: 'Disponível nos planos Pro, Premium e Vitalício.' });
    const { mes } = req.query;
    const filtroMes = mes || new Date().toISOString().slice(0,7);
    const pedidos = await db(`SELECT p.id,p.descricao,p.tipo,p.status,p.data_entrega,p.valor_total,p.valor_pago,c.nome AS cnome,c.apelido AS capelido,c.telefone AS ctel
        FROM pedidos p JOIN clientes c ON p.cliente_id=c.id
        WHERE p.grafica_id=$1 AND TO_CHAR(p.data_entrega,'YYYY-MM')=$2 AND p.status NOT IN ('cancelado')
        ORDER BY p.data_entrega ASC`, [gid, filtroMes]);
    res.json(pedidos);
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

// ─── CAIXA ──────────────────────────────────────────────────
router.get('/caixa', async (req, res) => {
  try {
    const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [req.gid]);
    if (!getPlano(g.plano).caixa) return res.status(403).json({ erro: 'Disponível nos planos Pro, Premium e Vitalício.' });
    const filtroMes = req.query.mes || new Date().toISOString().slice(0, 7);
    const [movs, resumo] = await Promise.all([
      db(`SELECT * FROM caixa WHERE grafica_id=$1 AND TO_CHAR(data,'YYYY-MM')=$2 ORDER BY data DESC, criado_em DESC`, [req.gid, filtroMes]),
      db.one(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor ELSE 0 END),0) AS entradas, COALESCE(SUM(CASE WHEN tipo='saida' THEN valor ELSE 0 END),0) AS saidas, COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor ELSE -valor END),0) AS saldo FROM caixa WHERE grafica_id=$1 AND TO_CHAR(data,'YYYY-MM')=$2`, [req.gid, filtroMes]),
    ]);
    res.json({ movs, resumo, mes: filtroMes });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/caixa', async (req, res) => {
  const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [req.gid]);
  if (!getPlano(g.plano).caixa) return res.status(403).json({ erro: 'Disponível nos planos Pro, Premium e Vitalício.' });
  const { tipo, valor, categoria, descricao, data } = req.body;
  if (!tipo || !valor || parseFloat(valor) <= 0) return res.status(400).json({ erro: 'Dados inválidos' });
  const m = await db.insert('INSERT INTO caixa (grafica_id,tipo,valor,categoria,descricao,data) VALUES ($1,$2,$3,$4,$5,$6)', [req.gid, tipo, parseFloat(valor), categoria||'Outros', descricao||'', data||new Date().toISOString().split('T')[0]]);
  res.json(m);
});

router.delete('/caixa/:id', async (req, res) => {
  const g = await db.one('SELECT plano FROM graficas WHERE id=$1', [req.gid]);
  if (!getPlano(g.plano).caixa) return res.status(403).json({ erro: 'Disponível nos planos Pro, Premium e Vitalício.' });
  await db('DELETE FROM caixa WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
  res.json({ ok: true });
});

// ─── CLIENTES — sem N+1 ─────────────────────────────────────
router.get('/clientes', async (req, res) => {
  try {
    const { busca } = req.query; const gid = req.gid;
    let sql = `SELECT c.*, (SELECT COUNT(*) FROM pedidos WHERE cliente_id=c.id AND grafica_id=$1) AS total_pedidos, COALESCE((SELECT SUM(CASE WHEN tipo='debito' THEN valor ELSE -valor END) FROM cobrancas WHERE cliente_id=c.id AND grafica_id=$1),0) AS saldo FROM clientes c WHERE c.grafica_id=$1`;
    const p = [gid];
    if (busca) { sql += ` AND (c.nome ILIKE $2 OR c.apelido ILIKE $2 OR c.telefone ILIKE $2)`; p.push(`%${busca}%`); }
    sql += ' ORDER BY c.nome';
    res.json(await db(sql, p));
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/clientes/:id', async (req, res) => {
  const c = await db.one('SELECT * FROM clientes WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
  if (!c) return res.status(404).json({ erro: 'Não encontrado' });
  c.saldo = await saldo(req.gid, c.id);
  c.pedidos = await db('SELECT * FROM pedidos WHERE cliente_id=$1 AND grafica_id=$2 ORDER BY criado_em DESC', [c.id, req.gid]);
  res.json(c);
});

router.post('/clientes', async (req, res) => {
  const plano = await checarPlano(req.gid);
  if (!plano.ok) return res.status(403).json({ erro: plano.erro });
  const { nome, apelido, telefone, instagram, endereco, observacoes, aniversario } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  const c = await db.insert('INSERT INTO clientes (grafica_id,nome,apelido,telefone,instagram,endereco,observacoes,aniversario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [req.gid, nome.trim(), apelido||'', telefone||'', instagram||'', endereco||'', observacoes||'', aniversario||null]);
  res.json(c);
});

router.put('/clientes/:id', async (req, res) => {
  const { nome, apelido, telefone, instagram, endereco, observacoes, aniversario } = req.body;
  await db('UPDATE clientes SET nome=$1,apelido=$2,telefone=$3,instagram=$4,endereco=$5,observacoes=$6,aniversario=$7 WHERE id=$8 AND grafica_id=$9', [nome, apelido||'', telefone||'', instagram||'', endereco||'', observacoes||'', aniversario||null, req.params.id, req.gid]);
  res.json({ ok: true });
});

router.delete('/clientes/:id', async (req, res) => {
  await db('DELETE FROM clientes WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
  res.json({ ok: true });
});

// ─── ORÇAMENTOS ─────────────────────────────────────────────
router.get('/orcamentos', async (req, res) => {
  try {
    const { status, busca } = req.query; const gid = req.gid;
    let sql = `SELECT o.*,c.nome AS cnome,c.apelido AS capelido,c.telefone AS ctel FROM orcamentos o JOIN clientes c ON o.cliente_id=c.id WHERE o.grafica_id=$1`;
    const p = [gid];
    if (status) { sql += ` AND o.status=$${p.length+1}`; p.push(status); }
    if (busca)  { sql += ` AND (o.descricao ILIKE $${p.length+1} OR c.nome ILIKE $${p.length+1})`; p.push(`%${busca}%`); }
    sql += ' ORDER BY o.criado_em DESC';
    res.json(await db(sql, p));
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/orcamentos', async (req, res) => {
  try {
    const gid = req.gid;
    const { cliente_id, descricao, tipo, quantidade, valor_total, validade, observacoes } = req.body;
    if (!cliente_id || !descricao?.trim()) return res.status(400).json({ erro: 'Cliente e descrição obrigatórios' });
    const o = await db.insert('INSERT INTO orcamentos (grafica_id,cliente_id,descricao,tipo,quantidade,valor_total,validade,observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [gid, cliente_id, descricao.trim(), tipo||'Outros', quantidade||1, parseFloat(valor_total)||0, validade||null, observacoes||'']);
    res.json(o);
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro ao salvar' }); }
});

router.put('/orcamentos/:id', async (req, res) => {
  try {
    const { cliente_id, descricao, tipo, quantidade, valor_total, validade, observacoes } = req.body;
    const o = await db.one('SELECT status FROM orcamentos WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
    if (!o) return res.status(404).json({ erro: 'Não encontrado' });
    if (o.status !== 'pendente') return res.status(400).json({ erro: 'Só é possível editar orçamentos pendentes' });
    await db('UPDATE orcamentos SET cliente_id=$1,descricao=$2,tipo=$3,quantidade=$4,valor_total=$5,validade=$6,observacoes=$7 WHERE id=$8 AND grafica_id=$9', [cliente_id, descricao, tipo, quantidade||1, parseFloat(valor_total)||0, validade||null, observacoes||'', req.params.id, req.gid]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro ao atualizar' }); }
});

router.delete('/orcamentos/:id', async (req, res) => {
  await db('DELETE FROM orcamentos WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
  res.json({ ok: true });
});

router.patch('/orcamentos/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pendente','aprovado','recusado'].includes(status)) return res.status(400).json({ erro: 'Status inválido' });
    const o = await db.one('SELECT id FROM orcamentos WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
    if (!o) return res.status(404).json({ erro: 'Não encontrado' });
    await db('UPDATE orcamentos SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro ao atualizar' }); }
});

// Converte orçamento aprovado em pedido oficial
router.post('/orcamentos/:id/converter', async (req, res) => {
  const gid = req.gid;
  const orc = await db.one('SELECT * FROM orcamentos WHERE id=$1 AND grafica_id=$2', [req.params.id, gid]);
  if (!orc) return res.status(404).json({ erro: 'Orçamento não encontrado' });
  if (orc.pedido_id) return res.status(400).json({ erro: 'Este orçamento já foi convertido em pedido' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hoje = new Date().toISOString().split('T')[0];
    const { rows: [ped] } = await client.query(`INSERT INTO pedidos (grafica_id,cliente_id,descricao,tipo,quantidade,valor_total,valor_pago,status,data_pedido,observacoes) VALUES ($1,$2,$3,$4,$5,$6,0,'pendente',$7,$8) RETURNING *`, [gid, orc.cliente_id, orc.descricao, orc.tipo, orc.quantidade, orc.valor_total, hoje, orc.observacoes||'']);
    if (orc.valor_total > 0) await client.query(`INSERT INTO cobrancas (grafica_id,cliente_id,pedido_id,tipo,valor,descricao,data) VALUES ($1,$2,$3,'debito',$4,$5,$6)`, [gid, orc.cliente_id, ped.id, orc.valor_total, `Saldo: ${orc.descricao}`, hoje]);
    await client.query(`UPDATE orcamentos SET status='aprovado', pedido_id=$1 WHERE id=$2`, [ped.id, orc.id]);
    await client.query('COMMIT');
    res.json(ped);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ erro: 'Erro ao converter' }); }
  finally { client.release(); }
});

router.get('/orcamentos/:id/pdf', async (req, res) => {
  try {
    const gid = req.gid;
    const orc = await db.one(`SELECT o.*,c.nome AS cnome,c.apelido AS capelido,c.telefone AS ctel FROM orcamentos o JOIN clientes c ON o.cliente_id=c.id WHERE o.id=$1 AND o.grafica_id=$2`, [req.params.id, gid]);
    if (!orc) return res.status(404).json({ erro: 'Não encontrado' });
    const g = await db.one('SELECT nome FROM graficas WHERE id=$1', [gid]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="orcamento-${orc.id}.pdf"`);
    orcamentoPdf(orc, g, res);
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro ao gerar PDF' }); }
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
    const { rows: [ped] } = await client.query('INSERT INTO pedidos (grafica_id,cliente_id,descricao,tipo,quantidade,valor_total,valor_pago,status,data_pedido,data_entrega,observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [gid, cliente_id, descricao.trim(), tipo||'Outros', quantidade||1, vt, vp, status||'pendente', data_pedido||null, data_entrega||null, observacoes||'']);
    if (vt-vp>0) await client.query(`INSERT INTO cobrancas (grafica_id,cliente_id,pedido_id,tipo,valor,descricao,data) VALUES ($1,$2,$3,'debito',$4,$5,$6)`, [gid, cliente_id, ped.id, vt-vp, `Saldo: ${descricao}`, data_pedido||new Date().toISOString().split('T')[0]]);
    if (vp>0) await client.query(`INSERT INTO caixa (grafica_id,tipo,valor,categoria,descricao,data) VALUES ($1,'entrada',$2,'Pedidos',$3,$4)`, [gid, vp, `Entrada: ${descricao}`, data_pedido||new Date().toISOString().split('T')[0]]);
    await client.query('COMMIT');
    res.json(ped);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ erro: 'Erro ao salvar' }); }
  finally { client.release(); }
});

// Fix: editar pedido recalcula cobrança
router.put('/pedidos/:id', async (req, res) => {
  const { descricao, tipo, quantidade, valor_total, valor_pago, status, data_pedido, data_entrega, observacoes } = req.body;
  const gid = req.gid; const pedId = req.params.id;
  const vt = parseFloat(valor_total)||0, vp = parseFloat(valor_pago)||0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE pedidos SET descricao=$1,tipo=$2,quantidade=$3,valor_total=$4,valor_pago=$5,status=$6,data_pedido=$7,data_entrega=$8,observacoes=$9 WHERE id=$10 AND grafica_id=$11', [descricao, tipo, quantidade, vt, vp, status, data_pedido||null, data_entrega||null, observacoes, pedId, gid]);
    await client.query(`DELETE FROM cobrancas WHERE pedido_id=$1 AND grafica_id=$2 AND tipo='debito'`, [pedId, gid]);
    if (vt-vp>0) {
      const { rows:[ped] } = await client.query('SELECT cliente_id FROM pedidos WHERE id=$1', [pedId]);
      if (ped) await client.query(`INSERT INTO cobrancas (grafica_id,cliente_id,pedido_id,tipo,valor,descricao,data) VALUES ($1,$2,$3,'debito',$4,$5,$6)`, [gid, ped.cliente_id, pedId, vt-vp, `Saldo: ${descricao}`, data_pedido||new Date().toISOString().split('T')[0]]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ erro: 'Erro ao atualizar' }); }
  finally { client.release(); }
});

router.delete('/pedidos/:id', async (req, res) => {
  await db('DELETE FROM pedidos WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
  res.json({ ok: true });
});

// Duplicar pedido
router.post('/pedidos/:id/duplicar', async (req, res) => {
  const gid = req.gid;
  const original = await db.one('SELECT * FROM pedidos WHERE id=$1 AND grafica_id=$2', [req.params.id, gid]);
  if (!original) return res.status(404).json({ erro: 'Pedido não encontrado' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hoje = new Date().toISOString().split('T')[0];
    const { rows:[novo] } = await client.query(`INSERT INTO pedidos (grafica_id,cliente_id,descricao,tipo,quantidade,valor_total,valor_pago,status,data_pedido,data_entrega,observacoes) VALUES ($1,$2,$3,$4,$5,$6,0,'pendente',$7,null,$8) RETURNING *`, [gid, original.cliente_id, `[CÓPIA] ${original.descricao}`, original.tipo, original.quantidade, original.valor_total, hoje, original.observacoes||'']);
    if (original.valor_total>0) await client.query(`INSERT INTO cobrancas (grafica_id,cliente_id,pedido_id,tipo,valor,descricao,data) VALUES ($1,$2,$3,'debito',$4,$5,$6)`, [gid, original.cliente_id, novo.id, original.valor_total, `Saldo: ${original.descricao}`, hoje]);
    await client.query('COMMIT');
    res.json(novo);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ erro: 'Erro ao duplicar' }); }
  finally { client.release(); }
});

router.post('/pedidos/:id/baixa-estoque', async (req, res) => {
  const { materiais } = req.body; const gid = req.gid;
  if (!materiais?.length) return res.status(400).json({ erro: 'Nenhum material' });
  try {
    for (const m of materiais) {
      if (!m.quantidade||m.quantidade<=0) continue;
      const mat = await db.one('SELECT * FROM materiais WHERE id=$1 AND grafica_id=$2', [m.id, gid]);
      if (!mat) continue;
      const nova = Math.max(0, parseFloat(mat.quantidade)-parseFloat(m.quantidade));
      await db('UPDATE materiais SET quantidade=$1 WHERE id=$2', [nova, mat.id]);
      await db(`INSERT INTO logs (grafica_id,tipo,descricao) VALUES ($1,'baixa_estoque',$2)`, [gid, `Baixa: ${mat.nome} -${m.quantidade}${mat.unidade} (Pedido #${req.params.id})`]);
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro ao dar baixa' }); }
});

// ─── COBRANÇAS ──────────────────────────────────────────────
router.get('/cobrancas', async (req, res) => {
  res.json(await db(`SELECT c.id,c.nome,c.apelido,c.telefone, COALESCE(SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END),0) AS saldo, MAX(CASE WHEN cb.tipo='debito' THEN cb.data END) AS ultimo FROM clientes c LEFT JOIN cobrancas cb ON cb.cliente_id=c.id AND cb.grafica_id=$1 WHERE c.grafica_id=$1 GROUP BY c.id HAVING COALESCE(SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END),0)>0 ORDER BY COALESCE(SUM(CASE WHEN cb.tipo='debito' THEN cb.valor ELSE -cb.valor END),0) DESC`, [req.gid]));
});

router.post('/cobrancas', async (req, res) => {
  const { cliente_id, tipo, valor, descricao, data } = req.body;
  if (!cliente_id||!valor) return res.status(400).json({ erro: 'Dados incompletos' });
  await db('INSERT INTO cobrancas (grafica_id,cliente_id,tipo,valor,descricao,data) VALUES ($1,$2,$3,$4,$5,$6)', [req.gid, cliente_id, tipo||'debito', parseFloat(valor), descricao||'', data||new Date().toISOString().split('T')[0]]);
  if (tipo==='pagamento') await db(`INSERT INTO caixa (grafica_id,tipo,valor,categoria,descricao,data) VALUES ($1,'entrada',$2,'Cobranças',$3,$4)`, [req.gid, parseFloat(valor), descricao||'Pagamento de cliente', data||new Date().toISOString().split('T')[0]]);
  res.json({ ok: true, saldo: await saldo(req.gid, cliente_id) });
});

router.get('/cobrancas/historico/:clienteId', async (req, res) => {
  res.json(await db('SELECT cb.*,p.descricao AS pdesc FROM cobrancas cb LEFT JOIN pedidos p ON cb.pedido_id=p.id WHERE cb.cliente_id=$1 AND cb.grafica_id=$2 ORDER BY cb.data DESC,cb.criado_em DESC', [req.params.clienteId, req.gid]));
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
  res.json(await db.insert('INSERT INTO materiais (grafica_id,nome,categoria,quantidade,unidade,qtd_minima) VALUES ($1,$2,$3,$4,$5,$6)', [req.gid, nome.trim(), categoria||'Geral', parseFloat(quantidade)||0, unidade||'un', parseFloat(qtd_minima)||0]));
});

router.put('/materiais/:id', async (req, res) => {
  const { nome, categoria, quantidade, unidade, qtd_minima } = req.body;
  await db('UPDATE materiais SET nome=$1,categoria=$2,quantidade=$3,unidade=$4,qtd_minima=$5 WHERE id=$6 AND grafica_id=$7', [nome, categoria, parseFloat(quantidade)||0, unidade, parseFloat(qtd_minima)||0, req.params.id, req.gid]);
  res.json({ ok: true });
});

router.delete('/materiais/:id', async (req, res) => {
  await db('DELETE FROM materiais WHERE id=$1 AND grafica_id=$2', [req.params.id, req.gid]);
  res.json({ ok: true });
});

router.post('/materiais/:id/mov', async (req, res) => {
  const { tipo, quantidade } = req.body; const gid = req.gid;
  const mat = await db.one('SELECT * FROM materiais WHERE id=$1 AND grafica_id=$2', [req.params.id, gid]);
  if (!mat) return res.status(404).json({ erro: 'Não encontrado' });
  const qtd = parseFloat(quantidade);
  const nova = tipo==='entrada' ? parseFloat(mat.quantidade)+qtd : Math.max(0, parseFloat(mat.quantidade)-qtd);
  await db('UPDATE materiais SET quantidade=$1 WHERE id=$2', [nova, mat.id]);
  res.json({ ok: true, quantidade: nova });
});

// ─── CONFIG ─────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  const g = await db.one('SELECT id,nome,email,plano,plano_expira FROM graficas WHERE id=$1', [req.gid]);
  res.json({ ...g, recursos: getPlano(g.plano) });
});

router.put('/config/nome', async (req, res) => {
  const { nome } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  await db('UPDATE graficas SET nome=$1 WHERE id=$2', [nome.trim(), req.gid]);
  res.json({ ok: true, nome: nome.trim() });
});

router.put('/config/senha', async (req, res) => {
  const { senha_atual, nova_senha } = req.body;
  if (!nova_senha||nova_senha.length<6) return res.status(400).json({ erro: 'Nova senha muito curta' });
  const g = await db.one('SELECT senha_hash FROM graficas WHERE id=$1', [req.gid]);
  const ok = await require('bcryptjs').compare(senha_atual, g.senha_hash);
  if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta' });
  const hash = await require('bcryptjs').hash(nova_senha, 10);
  await db('UPDATE graficas SET senha_hash=$1 WHERE id=$2', [hash, req.gid]);
  res.json({ ok: true });
});

module.exports = router;
