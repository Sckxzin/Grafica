if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const setup   = require('./setup');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',  require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api',       require('./routes/grafica'));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const PORT = process.env.PORT || 3000;
setup()
  .then(() => app.listen(PORT, () => console.log(`\n🌹 XzinTech rodando em http://localhost:${PORT}\n`)))
  .catch(e => { console.error('Falha:', e.message); process.exit(1); });
