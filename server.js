const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuração de CORS para permitir acesso de qualquer lugar
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// ---------------------------------------------------------------------------
// Banco de dados (SQLite)
// ---------------------------------------------------------------------------
const dbPath = process.env.DB_PATH || path.join(__dirname, 'messages.db');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    content TEXT NOT NULL,
    delivered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    fullName TEXT,
    maritalStatus TEXT,
    address TEXT,
    description TEXT,
    sign TEXT,
    age TEXT,
    photo TEXT
  );
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_user, to_user, content, delivered)
  VALUES (?, ?, ?, ?)
`);
const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);
const getHistory = db.prepare(`
  SELECT * FROM messages
  WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
  ORDER BY created_at ASC
`);
const getPending = db.prepare(`
  SELECT * FROM messages WHERE to_user = ? AND delivered = 0 ORDER BY created_at ASC
`);

// ---------------------------------------------------------------------------
// Usuários conectados agora (nome de usuário -> socket.id)
// ---------------------------------------------------------------------------
const onlineUsers = new Map();

function deliverMessage(from, to, content) {
  const targetSocketId = onlineUsers.get(to);
  const delivered = !!targetSocketId;

  const result = insertMessage.run(from, to, content, delivered ? 1 : 0);
  const message = {
    id: result.lastInsertRowid,
    from_user: from,
    to_user: to,
    content,
    delivered: delivered ? 1 : 0,
  };

  if (delivered) {
    io.to(targetSocketId).emit('message', message);
  }

  return message;
}

// ---------------------------------------------------------------------------
// WebSocket (Socket.IO)
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('register', (username) => {
    currentUser = username;
    onlineUsers.set(username, socket.id);
    console.log(`[online] ${username}`);

    const pending = getPending.all(username);
    pending.forEach((msg) => {
      socket.emit('message', msg);
      markDelivered.run(msg.id);
    });
  });

  socket.on('sendMessage', ({ from, to, content }) => {
    if (!from || !to || !content) return;
    deliverMessage(from, to, content);
  });

  socket.on('disconnect', () => {
    if (currentUser) {
      onlineUsers.delete(currentUser);
      console.log(`[offline] ${currentUser}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Rotas REST para Usuários (NOVO!)
// ---------------------------------------------------------------------------

// Criar ou Atualizar Perfil
app.post('/users', (req, res) => {
  const { username, password, fullName, maritalStatus, address, description, sign, age, photo } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });

  try {
    const stmt = db.prepare(`
      INSERT INTO users (username, password, fullName, maritalStatus, address, description, sign, age, photo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
      password=excluded.password, fullName=excluded.fullName, maritalStatus=excluded.maritalStatus,
      address=excluded.address, description=excluded.description, sign=excluded.sign,
      age=excluded.age, photo=excluded.photo
    `);
    stmt.run(username, password, fullName, maritalStatus, address, description, sign, age, photo);
    res.status(200).json({ message: 'Perfil salvo com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
  if (user) {
    res.json({ success: true, user });
  } else {
    res.status(401).json({ success: false, message: 'Usuário ou senha inválidos' });
  }
});

// Buscar todos os usuários (para o Live)
app.get('/users', (req, res) => {
  const currentUser = req.query.currentUser;
  let users;
  if (currentUser) {
    users = db.prepare('SELECT * FROM users WHERE username != ?').all(currentUser);
  } else {
    users = db.prepare('SELECT * FROM users').all();
  }
  res.json(users);
});

// ---------------------------------------------------------------------------
// Rotas de Mensagens
// ---------------------------------------------------------------------------
app.post('/messages', (req, res) => {
  const { from, to, content } = req.body;
  if (!from || !to || !content) {
    return res.status(400).json({ error: 'Campos obrigatórios: from, to, content' });
  }
  const message = deliverMessage(from, to, content);
  res.status(201).json(message);
});

app.get('/messages/:userA/:userB', (req, res) => {
  const { userA, userB } = req.params;
  const history = getHistory.all(userA, userB, userB, userA);
  res.json(history);
});

app.get('/online', (req, res) => {
  res.json(Array.from(onlineUsers.keys()));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});
