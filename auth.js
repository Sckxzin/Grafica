const jwt = require('jsonwebtoken');
const SECRET = () => process.env.JWT_SECRET;

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Não autenticado' });
  try {
    const p = jwt.verify(token, SECRET());
    if (p.role !== 'grafica') return res.status(403).json({ erro: 'Acesso negado' });
    req.gid = p.id; req.grafica = p; next();
  } catch { res.status(401).json({ erro: 'Token inválido ou expirado' }); }
}

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Não autenticado' });
  try {
    const p = jwt.verify(token, SECRET());
    if (p.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
    req.admin = p; next();
  } catch { res.status(401).json({ erro: 'Token inválido ou expirado' }); }
}

function token(payload, expira = '30d') {
  return jwt.sign(payload, SECRET(), { expiresIn: expira });
}

module.exports = { auth, authAdmin, token };
