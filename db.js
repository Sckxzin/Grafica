const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.connect()
  .then(c => { console.log('✅ Supabase conectado!'); c.release(); })
  .catch(e => console.error('❌ Erro banco:', e.message));

// Helper: executa query e retorna rows
const db = async (sql, params = []) => {
  const r = await pool.query(sql, params);
  return r.rows;
};

// Helper: retorna primeira linha ou null
db.one = async (sql, params = []) => {
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
};

// Helper: insert e retorna linha inserida
db.insert = async (sql, params = []) => {
  const r = await pool.query(sql + ' RETURNING *', params);
  return r.rows[0];
};

module.exports = { pool, db };
