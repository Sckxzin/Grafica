const { pool } = require('./db');

async function setup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS graficas (
        id              SERIAL PRIMARY KEY,
        nome            TEXT NOT NULL,
        email           TEXT NOT NULL UNIQUE,
        senha_hash      TEXT NOT NULL,
        plano           TEXT DEFAULT 'gratuito',
        plano_expira    DATE,
        ativo           BOOLEAN DEFAULT true,
        motivo_bloqueio TEXT,
        ultimo_acesso   TIMESTAMP,
        criado_em       TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS admins (
        id          SERIAL PRIMARY KEY,
        nome        TEXT NOT NULL,
        email       TEXT NOT NULL UNIQUE,
        senha_hash  TEXT NOT NULL,
        criado_em   TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS logs (
        id          SERIAL PRIMARY KEY,
        grafica_id  INT REFERENCES graficas(id) ON DELETE CASCADE,
        admin_id    INT REFERENCES admins(id) ON DELETE SET NULL,
        tipo        TEXT NOT NULL,
        descricao   TEXT,
        ip          TEXT,
        criado_em   TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tentativas (
        id          SERIAL PRIMARY KEY,
        email       TEXT NOT NULL,
        ip          TEXT,
        ok          BOOLEAN DEFAULT false,
        criado_em   TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS clientes (
        id          SERIAL PRIMARY KEY,
        grafica_id  INT NOT NULL REFERENCES graficas(id) ON DELETE CASCADE,
        nome        TEXT NOT NULL,
        apelido     TEXT,
        telefone    TEXT,
        instagram   TEXT,
        endereco    TEXT,
        observacoes TEXT,
        criado_em   TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pedidos (
        id            SERIAL PRIMARY KEY,
        grafica_id    INT NOT NULL REFERENCES graficas(id) ON DELETE CASCADE,
        cliente_id    INT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        descricao     TEXT NOT NULL,
        tipo          TEXT DEFAULT 'Outros',
        quantidade    INT DEFAULT 1,
        valor_total   NUMERIC(10,2) DEFAULT 0,
        valor_pago    NUMERIC(10,2) DEFAULT 0,
        status        TEXT DEFAULT 'pendente',
        data_pedido   DATE DEFAULT CURRENT_DATE,
        data_entrega  DATE,
        observacoes   TEXT,
        criado_em     TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cobrancas (
        id          SERIAL PRIMARY KEY,
        grafica_id  INT NOT NULL REFERENCES graficas(id) ON DELETE CASCADE,
        cliente_id  INT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        pedido_id   INT REFERENCES pedidos(id) ON DELETE SET NULL,
        tipo        TEXT NOT NULL CHECK (tipo IN ('debito','pagamento')),
        valor       NUMERIC(10,2) NOT NULL,
        descricao   TEXT,
        data        DATE DEFAULT CURRENT_DATE,
        criado_em   TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS materiais (
        id              SERIAL PRIMARY KEY,
        grafica_id      INT NOT NULL REFERENCES graficas(id) ON DELETE CASCADE,
        nome            TEXT NOT NULL,
        categoria       TEXT DEFAULT 'Geral',
        quantidade      NUMERIC(10,2) DEFAULT 0,
        unidade         TEXT DEFAULT 'un',
        qtd_minima      NUMERIC(10,2) DEFAULT 0,
        criado_em       TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS caixa (
        id          SERIAL PRIMARY KEY,
        grafica_id  INT NOT NULL REFERENCES graficas(id) ON DELETE CASCADE,
        tipo        TEXT NOT NULL CHECK (tipo IN ('entrada','saida')),
        valor       NUMERIC(10,2) NOT NULL,
        categoria   TEXT NOT NULL DEFAULT 'Outros',
        descricao   TEXT,
        data        DATE DEFAULT CURRENT_DATE,
        criado_em   TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_clientes_gid  ON clientes(grafica_id);
      CREATE INDEX IF NOT EXISTS idx_pedidos_gid   ON pedidos(grafica_id);
      CREATE INDEX IF NOT EXISTS idx_cobrancas_gid ON cobrancas(grafica_id);
      CREATE INDEX IF NOT EXISTS idx_materiais_gid ON materiais(grafica_id);
      CREATE INDEX IF NOT EXISTS idx_caixa_gid     ON caixa(grafica_id);
      CREATE INDEX IF NOT EXISTS idx_caixa_data    ON caixa(data DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_gid      ON logs(grafica_id);
    `);
    await client.query('COMMIT');
    console.log('✅ Tabelas prontas!');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Erro setup:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = setup;
