const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Conexão com o PostgreSQL (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Criar as tabelas
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        from_user TEXT NOT NULL,
        to_user TEXT NOT NULL,
        content TEXT NOT NULL,
        delivered INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        fullname TEXT,
        maritalstatus TEXT,
        address TEXT,
        description TEXT,
        sign TEXT,
        age TEXT,
        photo TEXT
      );
    `);

    // ⭐ NOVA TABELA: LIKES (curtidas)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        from_user TEXT NOT NULL,
        to_user TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(from_user, to_user)
      );
    `);

    // ⭐ NOVA TABELA: MATCHES (matches mútuos confirmados)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        user_a TEXT NOT NULL,
        user_b TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_a, user_b)
      );
    `);

    console.log('✅ Tabelas criadas/verificadas no PostgreSQL');
  } catch (err) {
    console.error('❌ Erro ao criar tabelas:', err.message);
  }
}
initDB();

const onlineUsers = new Map();

async function deliverMessage(from, to, content) {
  const targetSocketId = onlineUsers.get(to);
  const delivered = !!targetSocketId;
  try {
    const result = await pool.query(
      'INSERT INTO messages (from_user, to_user, content, delivered) VALUES ($1, $2, $3, $4) RETURNING id',
      [from, to, content, delivered ? 1 : 0]
    );
    const message = { id: result.rows[0].id, from_user: from, to_user: to, content, delivered: delivered ? 1 : 0 };
    if (delivered) io.to(targetSocketId).emit('message', message);
    return message;
  } catch (err) {
    console.error('Erro ao salvar mensagem:', err.message);
    return null;
  }
}

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('register', async (username) => {
    currentUser = username;
    onlineUsers.set(username, socket.id);
    try {
      const pending = await pool.query('SELECT * FROM messages WHERE to_user = $1 AND delivered = 0 ORDER BY created_at ASC', [username]);
      pending.rows.forEach((msg) => { socket.emit('message', msg); });
      await pool.query('UPDATE messages SET delivered = 1 WHERE to_user = $1 AND delivered = 0', [username]);
    } catch (err) { console.error(err.message); }
  });

  socket.on('sendMessage', ({ from, to, content }) => {
    if (from && to && content) deliverMessage(from, to, content);
  });

  socket.on('disconnect', () => { if (currentUser) onlineUsers.delete(currentUser); });
});

// ROTAS DE USUÁRIO
app.post('/users', async (req, res) => {
  const { username, password, fullName, maritalStatus, address, description, sign, age, photo } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
  try {
    await pool.query(
      `INSERT INTO users (username, password, fullname, maritalstatus, address, description, sign, age, photo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (username) DO UPDATE SET
       password = $2, fullname = $3, maritalstatus = $4, address = $5,
       description = $6, sign = $7, age = $8, photo = $9`,
      [username, password, fullName, maritalStatus, address, description, sign, age, photo]
    );
    res.status(200).json({ message: 'Perfil salvo!' });
  } catch (error) {
    console.error('Erro no banco:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
    if (result.rows.length > 0) {
      res.json({ success: true, user: result.rows[0] });
    } else {
      res.status(401).json({ success: false, message: 'Inválido' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/users', async (req, res) => {
  const currentUser = req.query.currentUser;
  try {
    let result;
    if (currentUser) {
      result = await pool.query('SELECT * FROM users WHERE username != $1', [currentUser]);
    } else {
      result = await pool.query('SELECT * FROM users');
    }
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ROTAS DE MENSAGENS
app.post('/messages', async (req, res) => {
  const { from, to, content } = req.body;
  if (!from || !to || !content) return res.status(400).json({ error: 'Campos obrigatórios' });
  const message = await deliverMessage(from, to, content);
  res.status(201).json(message);
});

app.get('/messages/:userA/:userB', async (req, res) => {
  const { userA, userB } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM messages WHERE (from_user = $1 AND to_user = $2) OR (from_user = $3 AND to_user = $4) ORDER BY created_at ASC',
      [userA, userB, userB, userA]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ⭐ ROTA: VER QUEM ESTÁ ONLINE
app.get('/online', (req, res) => {
  res.json(Array.from(onlineUsers.keys()));
});

// ============================================
// ⭐⭐ NOVAS ROTAS DE CURTIDA E MATCH ⭐⭐
// ============================================

// POST /like → registra uma curtida e verifica se virou match
app.post('/like', async (req, res) => {
  const { from, from_name, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'Campos from e to são obrigatórios' });
  if (from === to) return res.status(400).json({ error: 'Não pode curtir a si mesmo' });

  try {
    // 1. Salva a curtida (ignora se já existir)
    await pool.query(
      `INSERT INTO likes (from_user, to_user) VALUES ($1, $2)
       ON CONFLICT (from_user, to_user) DO NOTHING`,
      [from, to]
    );

    // 2. Verifica se a outra pessoa JÁ tinha curtido você (match mútuo)
    const reciprocal = await pool.query(
      'SELECT * FROM likes WHERE from_user = $1 AND to_user = $2',
      [to, from]
    );

    if (reciprocal.rows.length > 0) {
      // ⭐ É MATCH! Salva na tabela matches (ordem alfabética pra evitar duplicatas)
      const [a, b] = [from, to].sort();
      await pool.query(
        `INSERT INTO matches (user_a, user_b) VALUES ($1, $2)
         ON CONFLICT (user_a, user_b) DO NOTHING`,
        [a, b]
      );

      // ⭐ Notifica o outro usuário em tempo real via Socket.IO
      const targetSocketId = onlineUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('new_match', {
          from: from,
          from_name: from_name || from
        });
      }

      return res.json({ success: true, match: true });
    }

    // Não é match (ainda) — só registrou a curtida
    res.json({ success: true, match: false });

  } catch (error) {
    console.error('Erro em /like:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /matches/:user → retorna todos os matches de um usuário
app.get('/matches/:user', async (req, res) => {
  const { user } = req.params;
  try {
    const result = await pool.query(
      `SELECT 
         CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS match_user
       FROM matches
       WHERE user_a = $1 OR user_b = $1`,
      [user]
    );
    res.json({ matches: result.rows.map(r => r.match_user) });
  } catch (error) {
    console.error('Erro em /matches:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ⭐ BÔNUS: ver quem você já curtiu (pra não repetir no live)
app.get('/liked/:user', async (req, res) => {
  const { user } = req.params;
  try {
    const result = await pool.query(
      'SELECT to_user FROM likes WHERE from_user = $1',
      [user]
    );
    res.json({ liked: result.rows.map(r => r.to_user) });
  } catch (error) {
    console.error('Erro em /liked:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => { res.send('API de mensagens online e funcionando!'); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`API rodando na porta ${PORT}`); });
