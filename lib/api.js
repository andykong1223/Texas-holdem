const express = require('express');
const db = require('./db');
const auth = require('./auth');

function createApiRouter(getLobbyRooms) {
  const router = express.Router();

  router.post('/auth/register', (req, res) => {
    const result = auth.register(req.body || {});
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  router.post('/auth/login', (req, res) => {
    const result = auth.login(req.body || {});
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  router.get('/auth/me', auth.authMiddleware, (req, res) => {
    res.json({ user: db.publicUser(req.user) });
  });

  router.patch('/me', auth.authMiddleware, (req, res) => {
    const nickname = String(req.body?.nickname || '').trim();
    if (!nickname || nickname.length > 12) {
      return res.status(400).json({ error: '昵称 1–12 个字符' });
    }
    res.json({ user: db.updateNickname(req.user.id, nickname) });
  });

  router.get('/me/history', auth.authMiddleware, (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    res.json({ items: db.getUserHistory(req.user.id, { limit, offset }) });
  });

  router.get('/lobby/rooms', auth.optionalAuth, (_req, res) => {
    res.json({ rooms: getLobbyRooms() });
  });

  router.get('/lobby/recent-hands', auth.optionalAuth, (_req, res) => {
    res.json({ items: db.getRecentHands({ limit: 30 }) });
  });

  // 牌局记录（整场）
  router.get('/sessions', auth.authMiddleware, (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit) || 40);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    res.json({ items: db.listSessions({ limit, offset }) });
  });

  router.get('/sessions/:id', auth.authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const detail = db.getSessionDetail(id);
    if (!detail) return res.status(404).json({ error: '牌局不存在' });
    res.json({ session: detail });
  });

  // 玩家战绩榜
  router.get('/players/stats', auth.authMiddleware, (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    res.json({ items: db.listPlayerStats({ limit }) });
  });

  // 玩家详情（含 VPIP / PFR / C-bet 等）
  router.get('/players/:id', auth.authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: '无效玩家' });
    const detail = db.getPlayerDetail(id);
    if (!detail) return res.status(404).json({ error: '玩家不存在' });
    res.json({ player: detail });
  });

  // 当前用户 HUD
  router.get('/me/hud', auth.authMiddleware, (req, res) => {
    res.json({ hud: db.getPlayerHud(req.user.id) });
  });

  // Admin
  router.get('/admin/stats', auth.authMiddleware, auth.adminMiddleware, (_req, res) => {
    res.json(db.getAdminStats());
  });

  router.get('/admin/users', auth.authMiddleware, auth.adminMiddleware, (req, res) => {
    const q = String(req.query.q || '');
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    res.json(db.listUsers({ q, limit, offset }));
  });

  router.patch('/admin/users/:id', auth.authMiddleware, auth.adminMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const user = db.getUserById(id);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (req.body.status === 'active' || req.body.status === 'banned') {
      db.setUserStatus(id, req.body.status);
    }
    if (req.body.chips !== undefined) {
      const chips = parseInt(req.body.chips);
      if (Number.isNaN(chips) || chips < 0) return res.status(400).json({ error: '筹码无效' });
      db.setChips(id, chips);
    }
    if (req.body.adjustChips !== undefined) {
      const delta = parseInt(req.body.adjustChips);
      if (Number.isNaN(delta)) return res.status(400).json({ error: '调整额无效' });
      db.adjustChips(id, delta);
    }
    if (req.body.nickname) {
      const nickname = String(req.body.nickname).trim();
      if (!nickname || nickname.length > 12) return res.status(400).json({ error: '昵称无效' });
      db.updateNickname(id, nickname);
    }
    res.json({ user: db.publicUser(db.getUserById(id)) });
  });

  return router;
}

module.exports = { createApiRouter };
