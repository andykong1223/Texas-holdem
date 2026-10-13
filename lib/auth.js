const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'holdem-dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const DEFAULT_CHIPS = 10000;

function signToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

function register({ username, password, nickname }) {
  const u = String(username || '').trim().toLowerCase();
  const n = String(nickname || username || '').trim();
  const p = String(password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(u)) {
    return { error: '用户名需 3–20 位字母数字或下划线' };
  }
  if (p.length < 6) return { error: '密码至少 6 位' };
  if (!n || n.length > 12) return { error: '昵称 1–12 个字符' };
  if (db.getUserByUsername(u)) return { error: '用户名已存在' };

  const passwordHash = bcrypt.hashSync(p, 10);
  const user = db.createUser({
    username: u,
    passwordHash,
    nickname: n,
    chips: DEFAULT_CHIPS,
    role: 'user'
  });
  const token = signToken(user);
  return { token, user: db.publicUser(user) };
}

function login({ username, password }) {
  const u = String(username || '').trim().toLowerCase();
  const user = db.getUserByUsername(u);
  if (!user) return { error: '账号或密码错误' };
  if (user.status === 'banned') return { error: '账号已被封禁' };
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return { error: '账号或密码错误' };
  }
  return { token: signToken(user), user: db.publicUser(user) };
}

function ensureAdminSeed() {
  const existing = db.getUserByUsername('admin');
  if (existing) return;
  const passwordHash = bcrypt.hashSync('admin123', 10);
  db.createUser({
    username: 'admin',
    passwordHash,
    nickname: '管理员',
    role: 'admin',
    chips: 1000000
  });
  console.log('Seeded admin account: admin / admin123');
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies?.token || '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: '请先登录' });
  const user = db.getUserById(payload.uid);
  if (!user || user.status === 'banned') return res.status(401).json({ error: '账号无效或已封禁' });
  req.user = user;
  req.tokenPayload = payload;
  next();
}

function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies?.token || '');
  const payload = verifyToken(token);
  if (payload) {
    const user = db.getUserById(payload.uid);
    if (user && user.status !== 'banned') req.user = user;
  }
  next();
}

function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

function socketAuth(socket) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = db.getUserById(payload.uid);
  if (!user || user.status === 'banned') return null;
  return user;
}

module.exports = {
  JWT_SECRET,
  DEFAULT_CHIPS,
  signToken,
  verifyToken,
  register,
  login,
  ensureAdminSeed,
  authMiddleware,
  optionalAuth,
  adminMiddleware,
  socketAuth
};
