const { Pool } = require('pg');
if (process.env.NODE_ENV !== 'production') require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

pool.connect()
  .then(c => { console.log('✅ Supabase conectado!'); c.release(); })
  .catch(e => console.error('❌ Erro banco:', e.message));

const db = async (sql, params = []) => {
  const r = await pool.query(sql, params);
  return r.rows;
};
db.one = async (sql, params = []) => {
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
};
db.insert = async (sql, params = []) => {
  const r = await pool.query(sql + ' RETURNING *', params);
  return r.rows[0];
};

module.exports = { pool, db };
