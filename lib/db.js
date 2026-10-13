const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { computeHudFromHands } = require('./poker-stats');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'holdem.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname TEXT NOT NULL,
    chips INTEGER NOT NULL DEFAULT 10000,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    total_hands INTEGER NOT NULL DEFAULT 0,
    total_profit INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS game_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    room_name TEXT NOT NULL,
    host_user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    small_blind INTEGER NOT NULL,
    big_blind INTEGER NOT NULL,
    buy_in INTEGER NOT NULL,
    password_protected INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    FOREIGN KEY (host_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS hand_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    room_code TEXT NOT NULL,
    hand_number INTEGER NOT NULL,
    community_cards TEXT NOT NULL DEFAULT '[]',
    pot_total INTEGER NOT NULL DEFAULT 0,
    results TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES game_sessions(id)
  );

  CREATE TABLE IF NOT EXISTS hand_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id INTEGER NOT NULL,
    user_id INTEGER,
    nickname TEXT NOT NULL,
    seat_index INTEGER NOT NULL,
    profit INTEGER NOT NULL DEFAULT 0,
    won INTEGER NOT NULL DEFAULT 0,
    folded INTEGER NOT NULL DEFAULT 0,
    hole_cards TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (hand_id) REFERENCES hand_records(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_status ON game_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_hands_session ON hand_records(session_id);
  CREATE INDEX IF NOT EXISTS idx_hand_players_user ON hand_players(user_id);

  CREATE TABLE IF NOT EXISTS session_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id INTEGER,
    nickname TEXT NOT NULL,
    buy_in INTEGER NOT NULL DEFAULT 0,
    cash_out INTEGER NOT NULL DEFAULT 0,
    profit INTEGER NOT NULL DEFAULT 0,
    hands_played INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES game_sessions(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_session_results_user ON session_results(user_id);
  CREATE INDEX IF NOT EXISTS idx_session_results_session ON session_results(session_id);

  CREATE TABLE IF NOT EXISTS room_snapshots (
    room_code TEXT PRIMARY KEY,
    session_id INTEGER,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES game_sessions(id)
  );
`);

// 兼容旧库：手牌行动序列（用于 VPIP / PFR / C-bet 等）
try {
  db.exec(`ALTER TABLE hand_records ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'`);
} catch (_) { /* already exists */ }

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    chips: row.chips,
    role: row.role,
    status: row.status,
    totalHands: row.total_hands,
    totalProfit: row.total_profit,
    wins: row.wins,
    createdAt: row.created_at
  };
}

function createUser({ username, passwordHash, nickname, role = 'user', chips = 10000 }) {
  const stmt = db.prepare(`
    INSERT INTO users (username, password_hash, nickname, role, chips)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(username, passwordHash, nickname, role, chips);
  return getUserById(Number(result.lastInsertRowid));
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function updateNickname(id, nickname) {
  db.prepare(`UPDATE users SET nickname = ?, updated_at = datetime('now') WHERE id = ?`).run(nickname, id);
  return publicUser(getUserById(id));
}

function adjustChips(id, delta) {
  db.prepare(`
    UPDATE users SET chips = MAX(0, chips + ?), updated_at = datetime('now') WHERE id = ?
  `).run(delta, id);
  return publicUser(getUserById(id));
}

function setChips(id, chips) {
  db.prepare(`UPDATE users SET chips = ?, updated_at = datetime('now') WHERE id = ?`).run(Math.max(0, chips), id);
  return publicUser(getUserById(id));
}

function setUserStatus(id, status) {
  db.prepare(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  return publicUser(getUserById(id));
}

function listUsers({ q = '', limit = 50, offset = 0 } = {}) {
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT * FROM users
    WHERE (? = '' OR username LIKE ? OR nickname LIKE ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(q, like, like, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM users
    WHERE (? = '' OR username LIKE ? OR nickname LIKE ?)
  `).get(q, like, like).c;
  return { users: rows.map(publicUser), total };
}

function createSession({ roomCode, roomName, hostUserId, smallBlind, bigBlind, buyIn, passwordProtected }) {
  const result = db.prepare(`
    INSERT INTO game_sessions (room_code, room_name, host_user_id, small_blind, big_blind, buy_in, password_protected)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(roomCode, roomName, hostUserId, smallBlind, bigBlind, buyIn, passwordProtected ? 1 : 0);
  return Number(result.lastInsertRowid);
}

function closeSession(sessionId) {
  if (!sessionId) return;
  db.prepare(`
    UPDATE game_sessions SET status = 'closed', ended_at = datetime('now') WHERE id = ? AND status = 'active'
  `).run(sessionId);
}

function recordHand({ sessionId, roomCode, handNumber, communityCards, potTotal, results, players, actions }) {
  const handResult = db.prepare(`
    INSERT INTO hand_records (session_id, room_code, hand_number, community_cards, pot_total, results, actions)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    roomCode,
    handNumber,
    JSON.stringify(communityCards || []),
    potTotal || 0,
    JSON.stringify(results || []),
    JSON.stringify(actions || [])
  );
  const handId = Number(handResult.lastInsertRowid);
  const insertPlayer = db.prepare(`
    INSERT INTO hand_players (hand_id, user_id, nickname, seat_index, profit, won, folded, hole_cards)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 手数仍按手累计；盈亏/胜场改在整场结算时更新，避免按手重复计入战绩
  const updateHands = db.prepare(`
    UPDATE users SET total_hands = total_hands + 1, updated_at = datetime('now') WHERE id = ?
  `);

  for (const p of players || []) {
    insertPlayer.run(
      handId,
      p.userId || null,
      p.nickname,
      p.seatIndex,
      p.profit || 0,
      p.won ? 1 : 0,
      p.folded ? 1 : 0,
      JSON.stringify(p.holeCards || [])
    );
    if (p.userId) updateHands.run(p.userId);
  }
  return handId;
}

function recordSessionResults(sessionId, { reason = 'ended', handNumber = 0, results = [] } = {}) {
  if (!sessionId) return;
  const insert = db.prepare(`
    INSERT INTO session_results (session_id, user_id, nickname, buy_in, cash_out, profit, hands_played, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStats = db.prepare(`
    UPDATE users SET
      total_profit = total_profit + ?,
      wins = wins + ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);
  for (const r of results) {
    if (!r) continue;
    insert.run(
      sessionId,
      r.userId || null,
      r.name || '玩家',
      r.buyIn || 0,
      r.cashOut || 0,
      r.profit || 0,
      handNumber || 0,
      reason
    );
    if (r.userId) {
      updateStats.run(r.profit || 0, (r.profit || 0) > 0 ? 1 : 0, r.userId);
    }
  }
}

function getUserHistory(userId, { limit = 30, offset = 0 } = {}) {
  // 优先：整场结算记录
  const sessionRows = db.prepare(`
    SELECT sr.*, gs.room_code, gs.room_name, gs.small_blind, gs.big_blind, gs.buy_in AS table_buy_in,
           gs.started_at, gs.ended_at
    FROM session_results sr
    JOIN game_sessions gs ON gs.id = sr.session_id
    WHERE sr.user_id = ?
    ORDER BY sr.id DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);

  if (sessionRows.length > 0) {
    return sessionRows.map(r => ({
      type: 'session',
      sessionId: r.session_id,
      roomCode: r.room_code,
      roomName: r.room_name,
      buyIn: r.buy_in,
      cashOut: r.cash_out,
      profit: r.profit,
      handsPlayed: r.hands_played,
      reason: r.reason,
      won: r.profit > 0,
      createdAt: r.ended_at || r.created_at,
      startedAt: r.started_at,
      blinds: `${r.small_blind || '-'}/${r.big_blind || '-'}`
    }));
  }

  // 兼容旧数据：按 session 汇总每手盈亏
  const legacy = db.prepare(`
    SELECT hr.session_id, hr.room_code, gs.room_name, gs.small_blind, gs.big_blind,
           gs.started_at, gs.ended_at,
           SUM(hp.profit) AS profit,
           COUNT(*) AS hands_played,
           MAX(hr.created_at) AS created_at
    FROM hand_players hp
    JOIN hand_records hr ON hr.id = hp.hand_id
    LEFT JOIN game_sessions gs ON gs.id = hr.session_id
    WHERE hp.user_id = ? AND hr.session_id IS NOT NULL
    GROUP BY hr.session_id
    ORDER BY hr.session_id DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);

  return legacy.map(r => ({
    type: 'session',
    sessionId: r.session_id,
    roomCode: r.room_code,
    roomName: r.room_name,
    buyIn: null,
    cashOut: null,
    profit: r.profit || 0,
    handsPlayed: r.hands_played || 0,
    reason: 'ended',
    won: (r.profit || 0) > 0,
    createdAt: r.ended_at || r.created_at,
    startedAt: r.started_at,
    blinds: `${r.small_blind || '-'}/${r.big_blind || '-'}`
  }));
}

function getRecentHands({ limit = 40 } = {}) {
  const rows = db.prepare(`
    SELECT hr.*, gs.room_name
    FROM hand_records hr
    LEFT JOIN game_sessions gs ON gs.id = hr.session_id
    ORDER BY hr.id DESC
    LIMIT ?
  `).all(limit);
  return rows.map(r => ({
    id: r.id,
    roomCode: r.room_code,
    roomName: r.room_name,
    handNumber: r.hand_number,
    potTotal: r.pot_total,
    results: JSON.parse(r.results || '[]'),
    createdAt: r.created_at
  }));
}

function listSessions({ limit = 40, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT gs.*,
      (SELECT COUNT(*) FROM session_results sr WHERE sr.session_id = gs.id) AS player_count,
      (SELECT COALESCE(SUM(sr.buy_in), 0) FROM session_results sr WHERE sr.session_id = gs.id) AS total_buy_in,
      (SELECT COALESCE(MAX(sr.hands_played), 0) FROM session_results sr WHERE sr.session_id = gs.id) AS hands_played,
      (SELECT COUNT(*) FROM hand_records hr WHERE hr.session_id = gs.id) AS hand_count
    FROM game_sessions gs
    WHERE gs.status = 'closed'
    ORDER BY gs.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  return rows.map(r => ({
    id: r.id,
    roomCode: r.room_code,
    roomName: r.room_name,
    status: r.status,
    smallBlind: r.small_blind,
    bigBlind: r.big_blind,
    buyIn: r.buy_in,
    playerCount: r.player_count || 0,
    totalBuyIn: r.total_buy_in || 0,
    handsPlayed: r.hands_played || r.hand_count || 0,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    blinds: `${r.small_blind}/${r.big_blind}`
  }));
}

function getSessionDetail(sessionId) {
  const gs = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  if (!gs) return null;
  const results = db.prepare(`
    SELECT * FROM session_results WHERE session_id = ? ORDER BY profit DESC, id ASC
  `).all(sessionId).map(r => ({
    userId: r.user_id,
    name: r.nickname,
    buyIn: r.buy_in,
    cashOut: r.cash_out,
    profit: r.profit,
    handsPlayed: r.hands_played,
    reason: r.reason
  }));
  // 无 session_results 时，用手数汇总兜底
  if (!results.length) {
    const legacy = db.prepare(`
      SELECT hp.user_id, hp.nickname,
             SUM(hp.profit) AS profit,
             COUNT(*) AS hands_played
      FROM hand_players hp
      JOIN hand_records hr ON hr.id = hp.hand_id
      WHERE hr.session_id = ?
      GROUP BY hp.user_id, hp.nickname
      ORDER BY profit DESC
    `).all(sessionId).map(r => ({
      userId: r.user_id,
      name: r.nickname,
      buyIn: null,
      cashOut: null,
      profit: r.profit || 0,
      handsPlayed: r.hands_played || 0,
      reason: 'ended'
    }));
    return {
      id: gs.id,
      roomCode: gs.room_code,
      roomName: gs.room_name,
      status: gs.status,
      smallBlind: gs.small_blind,
      bigBlind: gs.big_blind,
      buyIn: gs.buy_in,
      startedAt: gs.started_at,
      endedAt: gs.ended_at,
      blinds: `${gs.small_blind}/${gs.big_blind}`,
      results: legacy
    };
  }
  return {
    id: gs.id,
    roomCode: gs.room_code,
    roomName: gs.room_name,
    status: gs.status,
    smallBlind: gs.small_blind,
    bigBlind: gs.big_blind,
    buyIn: gs.buy_in,
    startedAt: gs.started_at,
    endedAt: gs.ended_at,
    blinds: `${gs.small_blind}/${gs.big_blind}`,
    results
  };
}

function listPlayerStats({ limit = 50 } = {}) {
  const fromSessions = db.prepare(`
    SELECT user_id AS userId,
           MAX(nickname) AS nickname,
           COUNT(*) AS sessions,
           SUM(profit) AS profit,
           SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(buy_in) AS totalBuyIn,
           SUM(cash_out) AS totalCashOut,
           SUM(hands_played) AS handsPlayed
    FROM session_results
    WHERE user_id IS NOT NULL
    GROUP BY user_id
    ORDER BY profit DESC
    LIMIT ?
  `).all(limit);

  if (fromSessions.length) {
    return fromSessions.map(r => {
      const sessions = r.sessions || 0;
      const wins = r.wins || 0;
      return {
        userId: r.userId,
        nickname: r.nickname,
        sessions,
        profit: r.profit || 0,
        wins,
        totalBuyIn: r.totalBuyIn || 0,
        totalCashOut: r.totalCashOut || 0,
        handsPlayed: r.handsPlayed || 0,
        winRate: sessions ? Math.min(1, wins / sessions) : 0
      };
    });
  }

  // 旧数据兜底：按整场累计盈亏近似「盈利局」
  return db.prepare(`
    WITH per_session AS (
      SELECT hp.user_id AS user_id,
             MAX(hp.nickname) AS nickname,
             hr.session_id AS session_id,
             SUM(hp.profit) AS session_profit,
             COUNT(*) AS hands
      FROM hand_players hp
      JOIN hand_records hr ON hr.id = hp.hand_id
      WHERE hp.user_id IS NOT NULL
      GROUP BY hp.user_id, hr.session_id
    )
    SELECT user_id AS userId,
           MAX(nickname) AS nickname,
           COUNT(*) AS sessions,
           SUM(session_profit) AS profit,
           SUM(CASE WHEN session_profit > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(hands) AS handsPlayed
    FROM per_session
    GROUP BY user_id
    ORDER BY profit DESC
    LIMIT ?
  `).all(limit).map(r => {
    const sessions = r.sessions || 0;
    const wins = r.wins || 0;
    return {
      userId: r.userId,
      nickname: r.nickname,
      sessions,
      profit: r.profit || 0,
      wins,
      totalBuyIn: 0,
      totalCashOut: 0,
      handsPlayed: r.handsPlayed || 0,
      winRate: sessions ? Math.min(1, wins / sessions) : 0
    };
  });
}

function getAdminStats() {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const activeSessions = db.prepare(`SELECT COUNT(*) AS c FROM game_sessions WHERE status = 'active'`).get().c;
  const hands = db.prepare('SELECT COUNT(*) AS c FROM hand_records').get().c;
  return { users, activeSessions, hands };
}

function saveRoomSnapshot(roomCode, sessionId, payload) {
  db.prepare(`
    INSERT INTO room_snapshots (room_code, session_id, payload, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(room_code) DO UPDATE SET
      session_id = excluded.session_id,
      payload = excluded.payload,
      updated_at = datetime('now')
  `).run(roomCode, sessionId || null, JSON.stringify(payload));
}

function deleteRoomSnapshot(roomCode) {
  db.prepare('DELETE FROM room_snapshots WHERE room_code = ?').run(roomCode);
}

function listRoomSnapshots() {
  return db.prepare('SELECT room_code, session_id, payload, updated_at FROM room_snapshots').all()
    .map(r => ({
      roomCode: r.room_code,
      sessionId: r.session_id,
      payload: JSON.parse(r.payload || '{}'),
      updatedAt: r.updated_at
    }));
}

function getActiveSessions() {
  return db.prepare(`SELECT * FROM game_sessions WHERE status = 'active'`).all();
}

function getPlayerHandsForHud(userId, { limit = 800 } = {}) {
  const rows = db.prepare(`
    SELECT hp.user_id, hp.folded, hp.won, hp.profit, hp.hole_cards,
           hr.actions, hr.community_cards
    FROM hand_players hp
    JOIN hand_records hr ON hr.id = hp.hand_id
    WHERE hp.user_id = ?
    ORDER BY hr.id DESC
    LIMIT ?
  `).all(userId, limit);

  return rows.map(r => ({
    userId: r.user_id,
    folded: !!r.folded,
    won: !!r.won,
    profit: r.profit || 0,
    holeCards: JSON.parse(r.hole_cards || '[]'),
    actions: JSON.parse(r.actions || '[]'),
    communityCards: JSON.parse(r.community_cards || '[]')
  }));
}

function getPlayerHud(userId, { limit = 800 } = {}) {
  const hands = getPlayerHandsForHud(userId, { limit });
  const withActions = hands.filter(h => Array.isArray(h.actions) && h.actions.length > 0);
  const hud = computeHudFromHands(withActions.length ? withActions : []);
  hud.sampleHands = withActions.length;
  hud.totalHandsTracked = hands.length;
  hud.hasActionData = withActions.length > 0;
  return hud;
}

function getPlayerDetail(userId) {
  const row = getUserById(userId);
  if (!row) return null;

  const records = getUserHistory(userId, { limit: 40 });
  const sessions = records.length;
  const wins = records.filter(r => (r.profit || 0) > 0).length;
  const profit = records.reduce((s, r) => s + (r.profit || 0), 0);
  const handsPlayed = records.reduce((s, r) => s + (r.handsPlayed || 0), 0);
  const totalBuyIn = records.reduce((s, r) => s + (r.buyIn || 0), 0);
  const best = records.reduce((b, r) => (!b || r.profit > b.profit ? r : b), null);
  const worst = records.reduce((b, r) => (!b || r.profit < b.profit ? r : b), null);
  const hud = getPlayerHud(userId);

  return {
    user: publicUser(row),
    summary: {
      sessions,
      wins,
      losses: records.filter(r => (r.profit || 0) < 0).length,
      even: records.filter(r => (r.profit || 0) === 0).length,
      profit,
      handsPlayed: handsPlayed || row.total_hands || 0,
      totalBuyIn,
      winRate: sessions ? Math.min(1, wins / sessions) : 0,
      avgProfit: sessions ? Math.round(profit / sessions) : 0,
      best: best ? { sessionId: best.sessionId, profit: best.profit, roomName: best.roomName, date: best.createdAt } : null,
      worst: worst ? { sessionId: worst.sessionId, profit: worst.profit, roomName: worst.roomName, date: worst.createdAt } : null
    },
    hud,
    records
  };
}

module.exports = {
  db,
  publicUser,
  createUser,
  getUserById,
  getUserByUsername,
  updateNickname,
  adjustChips,
  setChips,
  setUserStatus,
  listUsers,
  createSession,
  closeSession,
  recordHand,
  recordSessionResults,
  getUserHistory,
  getRecentHands,
  listSessions,
  getSessionDetail,
  listPlayerStats,
  getPlayerHud,
  getPlayerDetail,
  getAdminStats,
  saveRoomSnapshot,
  deleteRoomSnapshot,
  listRoomSnapshots,
  getActiveSessions
};
