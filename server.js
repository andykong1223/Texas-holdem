const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./lib/db');
const auth = require('./lib/auth');
const { createApiRouter } = require('./lib/api');

auth.ensureAdminSeed();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/api', createApiRouter(getLobbyRooms));

const rooms = new Map();

function seatedPlayers(room) {
  return [...room.players.values(), ...room.awayPlayers.values()];
}

function findRoomByUserId(userId) {
  if (!userId) return null;
  for (const room of rooms.values()) {
    if (Array.from(room.players.values()).some(p => p.userId === userId)) return room;
    if (room.awayPlayers.has(userId)) return room;
  }
  return null;
}

function findRoomBySocket(socketId) {
  return Array.from(rooms.values()).find(
    r => r.players.has(socketId) || r.spectators.has(socketId)
  );
}

function isHostUser(room, userId) {
  return !!room && !!userId && room.hostUserId === userId;
}

function hostNameOf(room) {
  const host = seatedPlayers(room).find(p => p.userId === room.hostUserId);
  return host?.name || '—';
}

function getLobbyRooms() {
  return Array.from(rooms.values())
    .filter(r => !r._settling && (r.players.size > 0 || r.awayPlayers.size > 0))
    .map(r => ({
      id: r.id,
      name: r.name,
      playerCount: r.players.size + r.awayPlayers.size,
      maxPlayers: r.settings.maxPlayers,
      spectatorCount: r.spectators.size,
      isPlaying: r.gameState.status === 'playing',
      hasPassword: !!r.password,
      smallBlind: r.settings.smallBlind,
      bigBlind: r.settings.bigBlind,
      buyIn: r.settings.startingChips,
      sessionMinutes: r.settings.sessionMinutes || 0,
      sessionEndsAt: r.sessionEndsAt || 0,
      handNumber: r.gameState.handNumber || 0,
      hostName: hostNameOf(r)
    }))
    .sort((a, b) => Number(b.isPlaying) - Number(a.isPlaying) || b.playerCount - a.playerCount);
}

function settlePlayerToAccount(player) {
  if (!player?.userId) return;
  if (player.chips > 0) {
    db.adjustChips(player.userId, player.chips);
    player.chips = 0;
  }
}

function recordLedgerEntry(room, player) {
  if (!player) return;
  const key = player.userId || player.id;
  const buyIn = player.sessionBuyIn || 0;
  const cashOut = player.chips || 0;
  room.ledger.set(key, {
    userId: player.userId || null,
    name: player.name,
    buyIn,
    cashOut,
    profit: cashOut - buyIn
  });
}

function buildSettlementPayload(room, reason) {
  seatedPlayers(room).forEach(p => recordLedgerEntry(room, p));
  const results = Array.from(room.ledger.values()).sort((a, b) => b.profit - a.profit);
  return {
    roomId: room.id,
    roomName: room.name,
    reason,
    reasonText: reason === 'timeout' ? '牌局时间到，已自动结算' : (reason === 'host' ? '房主结束了牌局' : '牌局已结束'),
    results,
    endedAt: Date.now(),
    handNumber: room.gameState.handNumber || 0
  };
}

function notifyUserIds(userIds, event, payload) {
  const set = new Set(userIds.filter(Boolean));
  if (!set.size) return;
  for (const [, s] of io.of('/').sockets) {
    if (set.has(s.data.user?.id)) s.emit(event, payload);
  }
}

function settleSession(room, reason = 'ended') {
  if (!room || room._settling) return;
  room._settling = true;
  clearTurnTimer(room);
  if (room._nextHandTimer) { clearTimeout(room._nextHandTimer); room._nextHandTimer = null; }
  if (room._sessionTimer) { clearTimeout(room._sessionTimer); room._sessionTimer = null; }
  clearAllInRunout(room);

  const payload = buildSettlementPayload(room, reason);
  const userIds = seatedPlayers(room).map(p => p.userId);
  emitToRoom(room, 'session-settled', payload);
  notifyUserIds(userIds, 'session-settled', payload);

  // 整场战绩入库（个人中心按局展示）
  if (room.sessionId) {
    try {
      db.recordSessionResults(room.sessionId, {
        reason,
        handNumber: room.gameState.handNumber || 0,
        results: payload.results || []
      });
    } catch (err) {
      console.error('Failed to record session results:', err.message);
    }
  }

  seatedPlayers(room).forEach(p => settlePlayerToAccount(p));
  room.players.clear();
  room.awayPlayers.clear();
  if (room.sessionId) db.closeSession(room.sessionId);
  try { db.deleteRoomSnapshot(room.id); } catch (_) {}
  rooms.delete(room.id);
  console.log(`Session settled (${reason}): ${room.id}`);
}

function destroyRoom(room) {
  if (!room) return;
  if (room._settling) return;
  // 有时限牌局走结算；无在座/暂离玩家时才销毁
  if (room.players.size + room.awayPlayers.size > 0) {
    settleSession(room, 'ended');
    return;
  }
  clearTurnTimer(room);
  clearAllInRunout(room);
  if (room._nextHandTimer) clearTimeout(room._nextHandTimer);
  if (room._sessionTimer) clearTimeout(room._sessionTimer);
  if (room.sessionId) db.closeSession(room.sessionId);
  try { db.deleteRoomSnapshot(room.id); } catch (_) {}
  rooms.delete(room.id);
  console.log(`Room destroyed: ${room.id}`);
}

function serializePlayer(p) {
  return {
    userId: p.userId,
    name: p.name,
    chips: p.chips,
    seatIndex: p.seatIndex,
    isSittingOut: !!p.isSittingOut,
    holeCards: p.holeCards || [],
    currentBet: p.currentBet || 0,
    totalBet: p.totalBet || 0,
    folded: !!p.folded,
    allIn: !!p.allIn,
    hasActed: !!p.hasActed,
    hasRebought: !!p.hasRebought,
    handStartChips: p.handStartChips,
    sessionBuyIn: p.sessionBuyIn || 0,
    idleHands: p.idleHands || 0,
    wantSitOut: !!p.wantSitOut,
    wantLeaveSeat: !!p.wantLeaveSeat,
    pendingJoin: !!p.pendingJoin,
    pendingRebuy: p.pendingRebuy || 0,
    disconnected: true,
    expectReconnect: true
  };
}

function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    password: room.password || '',
    hostUserId: room.hostUserId,
    sessionId: room.sessionId,
    settings: room.settings,
    sessionStartedAt: room.sessionStartedAt || 0,
    sessionEndsAt: room.sessionEndsAt || 0,
    pendingSettle: !!room.pendingSettle,
    pendingSettleReason: room.pendingSettleReason || null,
    gameState: {
      status: room.gameState.status,
      deck: room.gameState.deck || [],
      communityCards: room.gameState.communityCards || [],
      pots: room.gameState.pots || [],
      currentPlayerIndex: room.gameState.currentPlayerIndex,
      dealerIndex: room.gameState.dealerIndex,
      handNumber: room.gameState.handNumber,
      bettingRound: room.gameState.bettingRound,
      currentBet: room.gameState.currentBet,
      lastRaise: room.gameState.lastRaise,
      minRaise: room.gameState.minRaise,
      headsUp: !!room.gameState.headsUp,
      sbSeat: room.gameState.sbSeat ?? -1,
      bbSeat: room.gameState.bbSeat ?? -1,
      timerEnd: 0
    },
    players: seatedPlayers(room).map(serializePlayer),
    handLogs: room.handLogs || [],
    ledger: Array.from((room.ledger || new Map()).entries()),
    chat: (room.chat || []).slice(-50),
    currentHandLog: room.currentHandLog || null
  };
}

function markRoomDirty(room) {
  if (!room || room._settling) return;
  room._dirty = true;
}

function persistRoomNow(room) {
  if (!room || room._settling) return;
  try {
    db.saveRoomSnapshot(room.id, room.sessionId, serializeRoom(room));
    room._dirty = false;
  } catch (err) {
    console.error('Failed to save room snapshot:', room.id, err.message);
  }
}

function hydratePlayer(data) {
  const fakeId = `offline:${data.userId || data.seatIndex}`;
  const p = new Player(fakeId, data.name, data.chips, data.seatIndex, data.userId);
  p.isSittingOut = !!data.isSittingOut;
  p.holeCards = data.holeCards || [];
  p.currentBet = data.currentBet || 0;
  p.totalBet = data.totalBet || 0;
  p.folded = !!data.folded;
  p.allIn = !!data.allIn;
  p.hasActed = !!data.hasActed;
  p.hasRebought = !!data.hasRebought;
  p.handStartChips = data.handStartChips ?? data.chips;
  p.sessionBuyIn = data.sessionBuyIn || data.chips || 0;
  p.idleHands = data.idleHands || 0;
  p.wantSitOut = !!data.wantSitOut;
  p.wantLeaveSeat = !!data.wantLeaveSeat;
  p.pendingJoin = !!data.pendingJoin;
  p.pendingRebuy = data.pendingRebuy || 0;
  p.disconnected = true;
  p.expectReconnect = true;
  return p;
}

function restoreRoomsFromDisk() {
  let snapshots = [];
  try {
    snapshots = db.listRoomSnapshots();
  } catch (err) {
    console.error('Failed to list room snapshots:', err.message);
    return;
  }
  for (const snap of snapshots) {
    const data = snap.payload;
    if (!data?.id) {
      db.deleteRoomSnapshot(snap.roomCode);
      continue;
    }
    try {
      const room = new Room(data.id, null, data.name, data.password || '', data.settings || {}, {
        sessionId: data.sessionId || snap.sessionId || null,
        hostUserId: data.hostUserId
      });
      Object.assign(room.gameState, data.gameState || {});
      room.sessionStartedAt = data.sessionStartedAt || 0;
      room.sessionEndsAt = data.sessionEndsAt || 0;
      room.pendingSettle = !!data.pendingSettle;
      room.pendingSettleReason = data.pendingSettleReason || null;
      room.handLogs = data.handLogs || [];
      room.currentHandLog = data.currentHandLog || null;
      room.chat = data.chat || [];
      room.ledger = new Map(data.ledger || []);

      for (const pd of data.players || []) {
        if (!pd.userId && pd.userId !== 0) continue;
        const player = hydratePlayer(pd);
        room.players.set(player.id, player);
      }

      if (room.players.size === 0 && room.awayPlayers.size === 0) {
        db.deleteRoomSnapshot(room.id);
        if (room.sessionId) db.closeSession(room.sessionId);
        continue;
      }

      rooms.set(room.id, room);

      // 恢复牌局时钟
      if (room.sessionEndsAt > 0) {
        const left = room.sessionEndsAt - Date.now();
        if (left <= 0) {
          room.pendingSettle = true;
          room.pendingSettleReason = room.pendingSettleReason || 'timeout';
          // 若不在下注中，直接结算
          if (room.gameState.status !== 'playing' || room.gameState.bettingRound === 'showdown') {
            settleSession(room, 'timeout');
            continue;
          }
        } else {
          room._sessionTimer = setTimeout(() => onSessionTimeout(room), left);
        }
      }

      // 牌局进行中：给玩家重连宽限期，避免立刻因离线被计时弃牌
      if (room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') {
        room.gameState.timerEnd = 0;
        setTimeout(() => {
          if (!rooms.has(room.id) || room._settling) return;
          const cur = getCurrentPlayer(room);
          if (cur) startTurnTimer(room);
        }, 90000);
      }

      console.log(`Restored room ${room.id} (${room.players.size} players, hand #${room.gameState.handNumber || 0})`);
    } catch (err) {
      console.error('Failed to restore room', snap.roomCode, err);
    }
  }

  // 清理无快照的幽灵 active session（避免后台统计虚高）
  try {
    const active = db.getActiveSessions();
    for (const s of active) {
      if (!rooms.has(s.room_code)) {
        // 没有可恢复的房间快照：关闭会话（桌上筹码已无法可靠退回时仅关会话）
        // 若有快照会在上面恢复；此处只处理孤儿
        const hasSnap = snapshots.some(x => x.roomCode === s.room_code);
        if (!hasSnap) {
          db.closeSession(s.id);
          console.log(`Closed orphan session #${s.id} room ${s.room_code}`);
        }
      }
    }
  } catch (_) {}
}

/** 把仍占座的玩家改挂到 offline:userId，便于旧 socket 离开后回连 */
function rekeyPlayerOffline(room, socketId, player) {
  if (!player?.userId) return socketId;
  const offlineId = `offline:${player.userId}`;
  if (socketId === offlineId) return offlineId;
  if (room.players.get(socketId) === player) room.players.delete(socketId);
  player.id = offlineId;
  room.players.set(offlineId, player);
  if (room.hostId === socketId) room.hostId = offlineId;
  return offlineId;
}

/**
 * 暂离/断线/刷新：保留座位与筹码。
 * 牌局进行中：不立刻弃牌/结束本手，只标记离线；行动倒计时继续，超时再自动过牌或弃牌。
 */
function parkPlayer(room, socketId, { expectReconnect = true } = {}) {
  const player = room.players.get(socketId);
  if (!player) return null;

  const inBetting = room.gameState.status === 'playing'
    && room.gameState.bettingRound !== 'showdown';

  if (inBetting) {
    const wasCurrent = room.gameState.currentPlayerIndex === player.seatIndex
      && !player.folded && !player.allIn;
    player.disconnected = true;
    player.expectReconnect = !!expectReconnect;
    if (!expectReconnect) player.sitOutAfterHand = true;
    rekeyPlayerOffline(room, socketId, player);
    // 倒计时不中断；若正在走表，给在线玩家同步一下剩余时间
    if (wasCurrent && room.turnTimer && room.gameState.timerEnd) {
      emitTurnTimer(room, player);
    } else if (wasCurrent && !room.settings.timerEnabled) {
      // 关闭行动计时时断线：立即代打，避免永久卡死
      setTimeout(() => {
        if (!rooms.has(room.id) || room._settling) return;
        const cur = getCurrentPlayer(room);
        if (cur && cur.userId === player.userId && cur.disconnected) {
          autoActOnTimeout(room);
        }
      }, 0);
    }
    return player;
  }

  // 未在下注中（等待/摊牌间隙）：移入 away，释放 socket 键
  if (player.userId) {
    player.disconnected = true;
    player.expectReconnect = !!expectReconnect;
    if (!expectReconnect) player.sitOutAfterHand = true;
    room.awayPlayers.set(player.userId, player);
  } else {
    recordLedgerEntry(room, player);
    settlePlayerToAccount(player);
  }
  room.players.delete(socketId);
  room.rebuyRequests.delete(socketId);
  if (room.hostId === socketId) {
    const online = Array.from(room.players.values()).filter(p => !p.disconnected);
    room.hostId = online[0]?.id || null;
  }
  if ([...room.players.values()].every(p => p.disconnected)) clearTurnTimer(room);
  return player;
}

/** 回桌后若人数够且牌局停在等待/摊牌，自动续开 */
function tryResumeHandIfNeeded(room) {
  if (!room || room._settling || room.pendingSettle) return;
  const eligible = Array.from(room.players.values()).filter(
    p => p.chips > 0 && !p.isSittingOut
  );
  if (eligible.length < 2) return;
  if (room.gameState.status === 'waiting') {
    startGame(room);
    broadcastState(room);
    return;
  }
  if (room.gameState.status === 'playing' && room.gameState.bettingRound === 'showdown') {
    if (!room._nextHandTimer) scheduleNextHand(room, AUTO_NEXT_HAND_MS);
  }
}

function reclaimPlayer(room, socket, user) {
  // 1) 暂离表
  let player = room.awayPlayers.get(user.id);
  if (player) {
    room.awayPlayers.delete(user.id);
  } else {
    // 2) 仍挂在旧 socket 上的断线玩家
    const entry = Array.from(room.players.entries()).find(([, p]) => p.userId === user.id);
    if (!entry) return null;
    const [oldId, p] = entry;
    if (oldId !== socket.id) room.players.delete(oldId);
    player = p;
  }
  player.id = socket.id;
  player.name = user.nickname || player.name;
  player.disconnected = false;
  player.expectReconnect = false;
  player.sitOutAfterHand = false;
  // 保留主动暂离状态，断线重连不应强制拉回入局
  room.players.set(socket.id, player);
  if (room.hostUserId === user.id) room.hostId = socket.id;
  socket.join(room.id);
  if (room.destructionTimeout) {
    clearTimeout(room.destructionTimeout);
    room.destructionTimeout = null;
  }
  return player;
}

function tryAutoRejoin(socket, user) {
  const room = findRoomByUserId(user.id);
  if (!room || room._settling) return false;

  const inSeat = Array.from(room.players.values()).find(p => p.userId === user.id);
  if (inSeat) {
    if (!inSeat.disconnected) return false; // 已在线
    if (!inSeat.expectReconnect) return false; // 主动离开，需手动再加入
  } else {
    const parked = room.awayPlayers.get(user.id);
    if (!parked || !parked.expectReconnect) return false;
  }

  reclaimPlayer(room, socket, user);
  socket.emit('joined-room', room.getPublicState(socket.id));
  socket.emit('wallet-update', { chips: db.getUserById(user.id)?.chips ?? 0 });
  broadcastState(room);
  persistRoomNow(room);
  // 回连：若轮到自己且计时已停才重开；进行中的倒计时不重置
  if (getCurrentPlayer(room)?.id === socket.id && !room.turnTimer) startTurnTimer(room);
  tryResumeHandIfNeeded(room);
  console.log(`Auto-rejoin: ${user.username} -> ${room.id}`);
  return true;
}

function startSessionClock(room) {
  const minutes = parseInt(room.settings.sessionMinutes) || 0;
  if (minutes <= 0) {
    room.sessionEndsAt = 0;
    return;
  }
  const ms = minutes * 60 * 1000;
  room.sessionStartedAt = Date.now();
  room.sessionEndsAt = room.sessionStartedAt + ms;
  if (room._sessionTimer) clearTimeout(room._sessionTimer);
  room._sessionTimer = setTimeout(() => onSessionTimeout(room), ms);
}

function onSessionTimeout(room) {
  if (!room || !rooms.has(room.id) || room._settling) return;
  // 正在打牌：本手结束后再结算
  if (room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') {
    room.pendingSettle = true;
    room.pendingSettleReason = 'timeout';
    emitToRoom(room, 'session-ending', {
      message: '时间到，本手结束后自动结算',
      sessionEndsAt: Date.now()
    });
    return;
  }
  if (room._nextHandTimer) {
    clearTimeout(room._nextHandTimer);
    room._nextHandTimer = null;
  }
  settleSession(room, 'timeout');
}

/** 连续未主动操作手数：达此值留位暂离 */
const IDLE_SIT_OUT_HANDS = 2;
/** 连续未主动操作手数：达此值离开座位（筹码回账户，变观战） */
const IDLE_LEAVE_SEAT_HANDS = 5;

class Player {
  constructor(id, name, chips, seatIndex, userId = null) {
    this.id = id;
    this.name = name;
    this.userId = userId;
    this.chips = chips;
    this.seatIndex = seatIndex;
    this.isActive = true;
    this.isSittingOut = false;
    this.holeCards = [];
    this.currentBet = 0;
    this.totalBet = 0;
    this.folded = false;
    this.allIn = false;
    this.hasActed = false;
    this.disconnected = false;
    this.hasRebought = false;
    this.handStartChips = chips;
    this.sessionBuyIn = chips; // 本场累计买入
    this.expectReconnect = false;
    this.sitOutAfterHand = false;
    this.shownHoleMask = [false, false]; // 摊牌阶段对外秀出的牌位
    this.idleHands = 0; // 连续无主动操作手数
    this.actedVoluntarilyThisHand = false;
    this.hadDecisionThisHand = false;
    this.wantSitOut = false; // 本手结束后暂离
    this.wantLeaveSeat = false; // 本手结束后离座
    this.pendingJoin = false; // 中途入座：等下一手再发牌
    this.pendingRebuy = 0; // 局中补码，下一手入账
  }
  
  resetForHand() {
    this.holeCards = [];
    this.currentBet = 0;
    this.totalBet = 0;
    this.folded = false;
    this.allIn = false;
    this.hasActed = false;
    this.shownHoleMask = [false, false];
    this.actedVoluntarilyThisHand = false;
    this.hadDecisionThisHand = false;
  }
}

class Room {
  constructor(id, hostId, name, password, settings, { sessionId = null, hostUserId = null } = {}) {
    this.id = id;
    this.hostId = hostId;
    this.hostUserId = hostUserId;
    this.sessionId = sessionId;
    this.name = name;
    this.password = password;
    this.settings = settings;
    this.players = new Map();
    this.awayPlayers = new Map(); // userId -> Player（暂离/断线，保留座位与筹码）
    this.spectators = new Set();
    this.chat = [];
    this.gameState = {
      status: 'waiting',
      deck: [],
      communityCards: [],
      pots: [],
      currentPlayerIndex: -1,
      dealerIndex: -1,
      handNumber: 0,
      bettingRound: 'preflop',
      currentBet: 0,
      lastRaise: 0,
      minRaise: 0,
      headsUp: false,
      sbSeat: -1,
      bbSeat: -1,
    };
    this.destructionTimeout = null;
    this.turnTimer = null;
    this.joinQueue = [];
    this.joinRequests = new Map();
    this.rebuyRequests = new Map();
    this.spectatorNames = new Map();
    this.spectatorUserIds = new Map();
    this.ledger = new Map(); // userId/socketId -> 结算条目（含中途离开）
    this.handLogs = []; // 本局已完成的手牌详细记录
    this.currentHandLog = null;
    this.sessionStartedAt = 0;
    this.sessionEndsAt = 0;
    this.pendingSettle = false;
    this._sessionTimer = null;
    this._settling = false;
  }
  
  getPublicState(requestingSocketId = null) {
    const isSpectator = this.spectators.has(requestingSocketId);
    const mapPlayer = (p, disconnected) => {
      const mask = Array.isArray(p.shownHoleMask) ? p.shownHoleMask : [false, false];
      const isSelf = p.id === requestingSocketId;
      const isShowdown = this.gameState.bettingRound === 'showdown';
      let holeCards = [];
      if (isSelf) {
        // 自己始终能看到完整底牌（含已弃牌）
        holeCards = [...(p.holeCards || [])];
      } else if (isShowdown && (p.holeCards || []).length > 0) {
        // 摊牌：按秀牌掩码对外露出；未秀出的位置用 null（前端可画牌背）
        holeCards = (p.holeCards || []).map((c, i) => (mask[i] ? c : null));
      }
      return {
        id: p.id,
        userId: p.userId,
        name: p.name,
        sessionBuyIn: p.sessionBuyIn || 0,
        chips: p.chips,
        seatIndex: p.seatIndex,
        isSittingOut: p.isSittingOut,
        wantSitOut: !!p.wantSitOut,
        pendingJoin: !!p.pendingJoin,
        hasRebought: p.hasRebought,
        folded: p.folded,
        allIn: p.allIn,
        currentBet: p.currentBet,
        holeCards,
        shownHoleMask: [...mask],
        isHost: this.hostUserId != null && p.userId === this.hostUserId,
        disconnected: !!disconnected,
        idleHands: p.idleHands || 0
      };
    };
    const players = [
      ...Array.from(this.players.values()).map(p => mapPlayer(p, !!p.disconnected)),
      ...Array.from(this.awayPlayers.values()).map(p => mapPlayer(p, true))
    ];
    const spectators = Array.from(this.spectators).map(sid => ({
      id: sid,
      name: this.spectatorNames.get(sid) || 'Spectator',
      wantsJoin: this.joinRequests.has(sid),
      joinApproved: this.joinQueue.includes(sid)
    }));
    const rebuyRequests = Array.from(this.rebuyRequests.entries()).map(([pid, req]) => ({
      playerId: pid,
      playerName: req.name,
      amount: req.amount
    }));
    const joinRequests = Array.from(this.joinRequests.entries()).map(([sid, req]) => ({
      spectatorId: sid,
      name: req.name,
      approved: req.approved
    }));
    return {
      id: this.id,
      name: this.name,
      hostId: this.hostId,
      hasPassword: !!this.password,
      settings: this.settings,
      players,
      spectators,
      spectatorCount: this.spectators.size,
      rebuyRequests,
      joinRequests,
      sessionEndsAt: this.sessionEndsAt || 0,
      sessionStartedAt: this.sessionStartedAt || 0,
      pendingSettle: !!this.pendingSettle,
      handHistoryCount: this.handLogs.length,
      gameState: {
        status: this.gameState.status,
        communityCards: this.gameState.communityCards,
        pots: this.gameState.pots,
        currentPlayerIndex: this.gameState.currentPlayerIndex,
        dealerIndex: this.gameState.dealerIndex,
        handNumber: this.gameState.handNumber,
        bettingRound: this.gameState.bettingRound,
        currentBet: this.gameState.currentBet,
        minRaise: this.gameState.minRaise,
        headsUp: !!this.gameState.headsUp,
        sbSeat: this.gameState.sbSeat ?? -1,
        bbSeat: this.gameState.bbSeat ?? -1,
        timerEnd: this.gameState.timerEnd || 0,
      },
      chat: this.chat.slice(-50)
    };
  }
}

function isLiveSocketId(sid) {
  return sid && !String(sid).startsWith('offline:');
}

function findLiveSocketIdByUserId(userId) {
  if (!userId) return null;
  for (const [id, s] of io.of('/').sockets) {
    if (s.data.user?.id === userId) return id;
  }
  return null;
}

function transferHostIfNeeded(room, leavingPlayer) {
  if (!leavingPlayer?.userId || leavingPlayer.userId !== room.hostUserId) return;
  const remaining = Array.from(room.players.values()).filter(p => p !== leavingPlayer);
  const activeHost = remaining.find(p => !p.isSittingOut && p.chips > 0 && !p.disconnected);
  const next = activeHost || remaining[0];
  if (next) {
    room.hostId = next.id;
    room.hostUserId = next.userId || room.hostUserId;
  }
}

/**
 * 离开座位：筹码回账户，变为观战（释放座位）。
 * 宜在两手之间调用；若仍在本手内，先标记 wantLeaveSeat，于 endHand 处理。
 */
function forceLeaveSeat(room, playerKey, reason = 'leave') {
  const player = room.players.get(playerKey);
  if (!player) return false;

  recordLedgerEntry(room, player);
  settlePlayerToAccount(player);
  transferHostIfNeeded(room, player);

  room.rebuyRequests.delete(playerKey);
  room.players.delete(playerKey);
  if (player.userId) room.awayPlayers.delete(player.userId);

  const notifySid = isLiveSocketId(playerKey)
    ? playerKey
    : findLiveSocketIdByUserId(player.userId);

  if (notifySid) {
    room.spectators.add(notifySid);
    room.spectatorNames.set(notifySid, player.name);
    if (player.userId) room.spectatorUserIds.set(notifySid, player.userId);
    const msg = reason === 'idle'
      ? `连续 ${IDLE_LEAVE_SEAT_HANDS} 手未操作，已自动离开座位`
      : '你已离开座位';
    io.to(notifySid).emit('set-spectator', true);
    io.to(notifySid).emit('forced-leave-seat', { reason, message: msg });
    const wallet = player.userId ? db.getUserById(player.userId)?.chips : null;
    if (wallet != null) io.to(notifySid).emit('wallet-update', { chips: wallet });
  }

  if (room.players.size === 0 && room.awayPlayers.size === 0 && room.spectators.size === 0) {
    destroyRoom(room);
    return true;
  }
  return true;
}

/** 一手结束后：统计空闲手数，自动暂离 / 离座；处理手动暂离与离座请求 */
function applyIdleAndSitOutRules(room) {
  const leaveKeys = [];

  for (const [sid, p] of room.players.entries()) {
    if (p.actedVoluntarilyThisHand) {
      p.idleHands = 0;
    } else if (p.hadDecisionThisHand) {
      p.idleHands = (p.idleHands || 0) + 1;
    } else if (p.isSittingOut && p.chips > 0 && !p.pendingJoin) {
      // 已暂离且仍占座：每过一手继续累计，满 5 手离座（中途待入局不算）
      p.idleHands = (p.idleHands || 0) + 1;
    }

    if (p.wantSitOut) {
      p.isSittingOut = true;
      p.wantSitOut = false;
    }

    if (p.wantLeaveSeat || (p.idleHands || 0) >= IDLE_LEAVE_SEAT_HANDS) {
      leaveKeys.push(sid);
      continue;
    }

    if ((p.idleHands || 0) >= IDLE_SIT_OUT_HANDS && !p.isSittingOut && p.chips > 0) {
      p.isSittingOut = true;
      if (isLiveSocketId(sid)) {
        io.to(sid).emit('auto-sit-out', {
          idleHands: p.idleHands,
          message: `连续 ${IDLE_SIT_OUT_HANDS} 手未操作，已自动暂离（留位）`
        });
      } else if (p.userId) {
        const live = findLiveSocketIdByUserId(p.userId);
        if (live) {
          io.to(live).emit('auto-sit-out', {
            idleHands: p.idleHands,
            message: `连续 ${IDLE_SIT_OUT_HANDS} 手未操作，已自动暂离（留位）`
          });
        }
      }
    }
  }

  for (const key of leaveKeys) {
    const p = room.players.get(key);
    const reason = p?.wantLeaveSeat ? 'leave' : 'idle';
    if (p) p.wantLeaveSeat = false;
    forceLeaveSeat(room, key, reason);
  }
}

function broadcastState(room) {
  markRoomDirty(room);
  room.players.forEach((_, sid) => {
    if (!isLiveSocketId(sid)) return;
    io.to(sid).emit('state-update', room.getPublicState(sid));
  });
  room.spectators.forEach(sid => io.to(sid).emit('state-update', room.getPublicState(sid)));
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function createDeck() {
  const suits = ['s', 'h', 'd', 'c'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (let s of suits) for (let r of ranks) deck.push({ r, s });
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function rankValue(r) {
  return { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, 'T':10, 'J':11, 'Q':12, 'K':13, 'A':14 }[r];
}

function evaluate5(cards) {
  const ranks = cards.map(c => rankValue(c.r)).sort((a,b) => b-a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);
  let isStraight = true;
  for (let i=0; i<4; i++) {
    if (ranks[i] - 1 !== ranks[i+1]) { isStraight = false; break; }
  }
  // A-5 轮子顺按 5-high 比较（避免 Ace 被当成最大踢脚）
  let straightValues = ranks;
  if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
    isStraight = true;
    straightValues = [5, 4, 3, 2, 1];
  }
  const counts = {};
  ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts).map(([r,c]) => [parseInt(r), c]).sort((a,b) => b[1] - a[1] || b[0] - a[0]);
  if (isFlush && isStraight) {
    return {
      rank: 8,
      values: straightValues,
      name: straightValues[0] === 14 ? 'Royal Flush' : 'Straight Flush'
    };
  }
  if (groups[0][1] === 4) return { rank: 7, values: [groups[0][0], groups[1][0]], name: 'Four of a Kind' };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { rank: 6, values: [groups[0][0], groups[1][0]], name: 'Full House' };
  if (isFlush) return { rank: 5, values: ranks, name: 'Flush' };
  if (isStraight) return { rank: 4, values: straightValues, name: 'Straight' };
  if (groups[0][1] === 3) return { rank: 3, values: [groups[0][0], groups[1][0], groups[2][0]], name: 'Three of a Kind' };
  if (groups[0][1] === 2 && groups[1][1] === 2) return { rank: 2, values: [groups[0][0], groups[1][0], groups[2][0]], name: 'Two Pair' };
  if (groups[0][1] === 2) return { rank: 1, values: [groups[0][0], groups[1][0], groups[2][0], groups[3][0]], name: 'One Pair' };
  return { rank: 0, values: ranks, name: 'High Card' };
}

function bestHand(cards) {
  let best = null;
  const n = cards.length;
  for(let i=0; i<n-4; i++)
    for(let j=i+1; j<n-3; j++)
      for(let k=j+1; k<n-2; k++)
        for(let l=k+1; l<n-1; l++)
          for(let m=l+1; m<n; m++) {
            const hand = evaluate5([cards[i],cards[j],cards[k],cards[l],cards[m]]);
            if (!best || compareHands(hand, best) > 0) best = hand;
          }
  return best;
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i=0; i<a.values.length; i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0;
}

function calculatePots(players) {
  let pots = [];
  let active = players.filter(p => !p.folded && p.totalBet > 0);
  let allContributors = players.filter(p => p.totalBet > 0);
  if (allContributors.length === 0) return [];
  // 无人未弃牌但仍有注码：按投入退回（避免底池蒸发）
  if (active.length === 0) {
    return [{
      amount: allContributors.reduce((s, p) => s + p.totalBet, 0),
      eligible: [],
      refundIds: allContributors.map(p => p.id)
    }];
  }

  let levels = [...new Set(allContributors.map(p => p.totalBet))].sort((a,b) => a-b);
  let prevLevel = 0;
  for (let level of levels) {
    let diff = level - prevLevel;
    let contributors = allContributors.filter(p => p.totalBet >= level);
    let potAmount = diff * contributors.length;
    let eligible = active.filter(p => p.totalBet >= level).map(p => p.id);
    pots.push({ amount: potAmount, eligible });
    prevLevel = level;
  }
  return pots;
}

function processJoinQueue(room) {
  if (room.destructionTimeout) {
    clearTimeout(room.destructionTimeout);
    room.destructionTimeout = null;
  }
  if (room.joinQueue.length === 0) return;
  // 含 awayPlayers，避免与断线占座冲突
  const usedSeats = new Set(seatedPlayers(room).map(p => p.seatIndex));
  const availableSeats = [];
  for (let i = 0; i < room.settings.maxPlayers; i++) {
    if (!usedSeats.has(i)) availableSeats.push(i);
  }
  while (room.joinQueue.length > 0 && availableSeats.length > 0) {
    const sid = room.joinQueue.shift();
    const name = room.spectatorNames.get(sid) || 'Player';
    const userId = room.spectatorUserIds.get(sid) || null;
    const buyIn = room.settings.startingChips;
    if (userId) {
      const fresh = db.getUserById(userId);
      if (!fresh || fresh.chips < buyIn) {
        io.to(sid).emit('error-msg', `入座失败：账户筹码不足（需要 ${buyIn}）`);
        room.joinRequests.delete(sid);
        continue;
      }
      db.adjustChips(userId, -buyIn);
      io.to(sid).emit('wallet-update', { chips: db.getUserById(userId).chips });
    }
    const seatIndex = availableSeats.shift();
    const player = new Player(sid, name, buyIn, seatIndex, userId);
    room.players.set(sid, player);
    room.spectators.delete(sid);
    room.spectatorNames.delete(sid);
    room.spectatorUserIds.delete(sid);
    room.joinRequests.delete(sid);
    io.to(sid).emit('set-spectator', false);
    io.to(sid).emit('joined-as-player', { seatIndex });
  }
}

function startGame(room) {
  if (room.players.size < 2) return;
  // 仅允许从等待开局；禁止下注中重入导致吞池
  if (room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') {
    return;
  }
  room.gameState.status = 'playing';
  // 首手由 startHand 选最小座位为庄，此处不预置再 +1
  if (room.gameState.dealerIndex === -1 ||
      !Array.from(room.players.values()).some(p => p.seatIndex === room.gameState.dealerIndex && p.chips > 0 && !p.isSittingOut)) {
    room.gameState.dealerIndex = -1;
  }
  startHand(room);
}

function emitHandStarted(room) {
  room.players.forEach((_, sid) => {
    if (!isLiveSocketId(sid)) return;
    io.to(sid).emit('hand-started', room.getPublicState(sid));
  });
  room.spectators.forEach(sid => io.to(sid).emit('hand-started', room.getPublicState(sid)));
}

/** 本街已无法继续下注（全下）时，收池进入下一街/摊牌 */
function beginAllInRunoutFromStreet(room) {
  room.gameState.pots = calculatePots(Array.from(room.players.values()));
  Array.from(room.players.values()).forEach(p => { p.currentBet = 0; });
  room.gameState.currentBet = 0;
  room.gameState.minRaise = room.settings.bigBlind;
  room.gameState.currentPlayerIndex = -1;
  room.gameState.timerEnd = 0;
  advanceRound(room);
  broadcastState(room);
}

function startHand(room) {
  // 下注进行中禁止重开一手（否则 totalBet 被清零 → 池内筹码蒸发）
  if (room.gameState.status === 'playing'
    && ['preflop', 'flop', 'turn', 'river'].includes(room.gameState.bettingRound)
    && !room._handSettled) {
    console.warn(`[startHand] blocked mid-hand restart in room ${room.id} (${room.gameState.bettingRound})`);
    return;
  }

  room._handSettled = false;
  clearAllInRunout(room);
  clearTurnTimer(room);
  room.gameState.deck = createDeck();
  shuffleDeck(room.gameState.deck);
  room.gameState.communityCards = [];
  room.gameState.pots = [];
  room.gameState.currentBet = 0;
  room.gameState.lastRaise = room.settings.bigBlind;
  room.gameState.minRaise = room.settings.bigBlind;
  room.gameState.bettingRound = 'preflop';
  
  // 买入回桌 / 中途入座 / 待入账补码：下一手正式入局
  Array.from(room.players.values()).forEach(p => {
    if (p.hasRebought || p.pendingJoin || (p.pendingRebuy || 0) > 0) {
      if ((p.pendingRebuy || 0) > 0) {
        p.chips = (p.chips || 0) + p.pendingRebuy;
        p.pendingRebuy = 0;
      }
      p.isSittingOut = false;
      p.hasRebought = false;
      p.pendingJoin = false;
      p.idleHands = 0;
      p.wantSitOut = false;
    }
  });
  
  // CRITICAL FIX: Reset ALL players' hand state at the start of every hand.
  Array.from(room.players.values()).forEach(p => {
    p.resetForHand();
    p.handStartChips = p.chips;
  });
  
  // 断线但仍 expectReconnect 的玩家照常发牌，超时自动行动（避免二人桌一人断线就停局）
  const activePlayers = Array.from(room.players.values())
    .filter(p => p.chips > 0 && !p.isSittingOut);
  
  // Mark non-active players (bankrupt, sitting out) as folded
  Array.from(room.players.values()).forEach(p => {
    if (!activePlayers.includes(p)) {
      p.folded = true;
    }
  });
  
  if (activePlayers.length < 2) {
    room.gameState.status = 'waiting';
    // Notify host why the hand couldn't start
    if (room.hostId) {
      io.to(room.hostId).emit('error-msg', 'Need at least 2 players with chips to start. Approve rebuy requests or wait for players to join.');
    }
    return;
  }

  room.gameState.handNumber++;
  
  const sortedSeats = activePlayers.map(p => p.seatIndex).sort((a,b) => a-b);
  const oldDealer = room.gameState.dealerIndex;
  const dealerIdx = sortedSeats.indexOf(oldDealer);
  if (dealerIdx < 0) {
    // 首手或旧庄已离桌：取顺时针第一位活跃座，不再错误地 0 再 +1
    room.gameState.dealerIndex = sortedSeats.find(s => s > oldDealer) ?? sortedSeats[0];
  } else {
    room.gameState.dealerIndex = sortedSeats[(dealerIdx + 1) % sortedSeats.length];
  }
  const dealer = activePlayers.find(p => p.seatIndex === room.gameState.dealerIndex);
  const headsUp = activePlayers.length === 2;
  // Heads-up：庄家兼小盲；多人：庄家左侧小盲、再左侧大盲
  const sbPlayer = headsUp
    ? dealer
    : activePlayers.find(p => p.seatIndex === sortedSeats[(sortedSeats.indexOf(dealer.seatIndex) + 1) % sortedSeats.length]);
  const bbPlayer = headsUp
    ? activePlayers.find(p => p.seatIndex !== dealer.seatIndex)
    : activePlayers.find(p => p.seatIndex === sortedSeats[(sortedSeats.indexOf(dealer.seatIndex) + 2) % sortedSeats.length]);
  room.gameState.headsUp = headsUp;
  room.gameState.sbSeat = sbPlayer.seatIndex;
  room.gameState.bbSeat = bbPlayer.seatIndex;
  postBlind(sbPlayer, room.settings.smallBlind);
  postBlind(bbPlayer, room.settings.bigBlind);
  // 面对短码盲注时，当前需跟注额取实际已出的最大盲
  room.gameState.currentBet = Math.max(sbPlayer.currentBet, bbPlayer.currentBet);
  for(let i=0; i<2; i++) {
    for(let p of activePlayers) {
      p.holeCards.push(room.gameState.deck.pop());
    }
  }
  beginHandLog(room, activePlayers);
  logHandAction(room, sbPlayer, 'sb', { amount: sbPlayer.totalBet });
  logHandAction(room, bbPlayer, 'bb', { amount: bbPlayer.totalBet });
  // 翻前首位：Heads-up = 庄/小盲；多人 = 大盲左侧（枪口）
  // 若该位已因盲注全下，则顺时针找下一位可行动者
  if (headsUp) {
    room.gameState.currentPlayerIndex = (!sbPlayer.allIn)
      ? sbPlayer.seatIndex
      : findNextSeatClockwise(room, sbPlayer.seatIndex, { canActOnly: true });
  } else {
    room.gameState.currentPlayerIndex = findNextSeatClockwise(room, bbPlayer.seatIndex, { canActOnly: true });
  }

  const canActNow = activePlayers.filter(p => !p.allIn);
  if (canActNow.length === 0 || room.gameState.currentPlayerIndex < 0 || !getCurrentPlayer(room)) {
    // 盲注后无人可行动（例如双方短码全下）→ 直接发公共牌，禁止卡死在计时器
    emitHandStarted(room);
    beginAllInRunoutFromStreet(room);
    persistRoomNow(room);
    return;
  }

  emitHandStarted(room);
  startTurnTimer(room);
  persistRoomNow(room);
}

function postBlind(player, amount) {
  const blind = Math.min(amount, player.chips);
  player.chips -= blind;
  player.currentBet = blind;
  player.totalBet = blind;
  if (player.chips === 0) player.allIn = true;
}

function beginHandLog(room, activePlayers) {
  room.currentHandLog = {
    handNumber: room.gameState.handNumber,
    dealerSeat: room.gameState.dealerIndex,
    bigBlind: room.settings.bigBlind || 20,
    smallBlind: room.settings.smallBlind || 10,
    startedAt: Date.now(),
    endedAt: 0,
    communityCards: [],
    streets: { preflop: [], flop: [], turn: [], river: [] },
    actions: [],
    players: activePlayers.map(p => ({
      playerId: p.id,
      userId: p.userId,
      name: p.name,
      seatIndex: p.seatIndex,
      holeCards: [...(p.holeCards || [])],
      showed: false,
      folded: false,
      startChips: p.handStartChips ?? p.chips,
      endChips: null,
      profit: 0,
      wonAmount: 0,
      handName: null
    })),
    potTotal: 0,
    results: []
  };
}

function logHandAction(room, player, action, { amount = 0, raiseBy = 0 } = {}) {
  if (!room.currentHandLog || !player) return;
  const entry = {
    street: room.gameState.bettingRound,
    playerId: player.id,
    userId: player.userId,
    name: player.name,
    seatIndex: player.seatIndex,
    action,
    amount,
    raiseBy,
    totalBet: player.totalBet,
    streetBet: player.currentBet,
    allIn: !!player.allIn,
    chipsLeft: player.chips
  };
  room.currentHandLog.actions.push(entry);
  const streetArr = room.currentHandLog.streets[entry.street];
  if (streetArr) streetArr.push(entry);
}

function syncHandLogHoleCards(room) {
  if (!room.currentHandLog) return;
  for (const row of room.currentHandLog.players) {
    const p = room.players.get(row.playerId)
      || Array.from(room.players.values()).find(x => x.userId && x.userId === row.userId);
    if (p?.holeCards?.length) row.holeCards = [...p.holeCards];
  }
}

function finalizeHandLog(room, results) {
  const log = room.currentHandLog;
  if (!log) return null;
  syncHandLogHoleCards(room);
  log.endedAt = Date.now();
  log.communityCards = [...(room.gameState.communityCards || [])];
  log.results = (results || []).map(r => ({ ...r }));
  log.potTotal = (room.gameState.pots || []).reduce((s, p) => s + (p.amount || 0), 0)
    || results.reduce((s, r) => s + (r.amount || 0), 0);

  const wonByPlayer = new Map();
  const handNameByPlayer = new Map();
  for (const r of results || []) {
    wonByPlayer.set(r.playerId, (wonByPlayer.get(r.playerId) || 0) + (r.amount || 0));
    if (r.hand) handNameByPlayer.set(r.playerId, r.hand);
  }

  for (const row of log.players) {
    const p = room.players.get(row.playerId)
      || Array.from(room.players.values()).find(x => x.userId && x.userId === row.userId);
    if (p) {
      row.endChips = p.chips;
      row.profit = p.chips - (row.startChips || 0);
      row.folded = !!p.folded;
      row.showed = !p.folded; // 摊牌/未弃牌即视为秀过
      row.holeCards = [...(p.holeCards || row.holeCards || [])];
    } else {
      row.endChips = row.startChips + (row.profit || 0);
      row.folded = true;
      row.showed = false;
    }
    row.wonAmount = wonByPlayer.get(row.playerId) || 0;
    row.handName = handNameByPlayer.get(row.playerId) || null;
  }

  room.handLogs.push(log);
  room.currentHandLog = null;
  return log;
}

function sanitizeHandLogForViewer(log, viewerUserId) {
  if (!log) return null;
  return {
    handNumber: log.handNumber,
    dealerSeat: log.dealerSeat,
    bigBlind: log.bigBlind || 20,
    smallBlind: log.smallBlind || 10,
    startedAt: log.startedAt,
    endedAt: log.endedAt,
    communityCards: log.communityCards || [],
    actions: log.actions || [],
    streets: log.streets || {},
    potTotal: log.potTotal || 0,
    results: log.results || [],
    players: (log.players || []).map(p => {
      const isMe = !!(viewerUserId && p.userId === viewerUserId);
      const mask = Array.isArray(p.shownHoleMask) ? p.shownHoleMask : null;
      let holeCards = [];
      if (isMe || p.showed) {
        if (mask && !isMe) {
          holeCards = (p.holeCards || []).map((c, i) => (mask[i] ? c : null));
        } else {
          holeCards = p.holeCards || [];
        }
      }
      return {
        userId: p.userId,
        name: p.name,
        seatIndex: p.seatIndex,
        holeCards,
        showed: !!p.showed,
        folded: !!p.folded,
        startChips: p.startChips,
        endChips: p.endChips,
        profit: p.profit,
        wonAmount: p.wonAmount,
        handName: p.handName,
        isMe: !!(viewerUserId && p.userId === viewerUserId)
      };
    })
  };
}

function emitTurnTimer(room, player) {
  const endTime = room.gameState.timerEnd || 0;
  room.players.forEach((_, sid) => {
    if (!isLiveSocketId(sid)) return;
    io.to(sid).emit('turn-timer', { playerId: player.id, endTime });
  });
  room.spectators.forEach(sid => io.to(sid).emit('turn-timer', { playerId: player.id, endTime }));
}

/** 行动超时：已跟平则过牌，否则弃牌（在线/离线同一套） */
function autoActOnTimeout(room) {
  const cur = getCurrentPlayer(room);
  if (!cur) return;
  if (room.gameState.status !== 'playing' || room.gameState.bettingRound === 'showdown') return;
  const canCheck = cur.currentBet >= (room.gameState.currentBet || 0);
  processAction(cur.id, canCheck ? 'check' : 'fold', 0, { auto: true });
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  const player = getCurrentPlayer(room);
  if (!player) return;
  player.hadDecisionThisHand = true;
  if (!room.settings.timerEnabled) {
    room.gameState.timerEnd = 0;
    emitTurnTimer(room, player);
    return;
  }
  const ms = room.settings.timerSeconds * 1000;
  room.gameState.timerEnd = Date.now() + ms;
  emitTurnTimer(room, player);
  room.turnTimer = setTimeout(() => autoActOnTimeout(room), ms);
}

/** 当前行动玩家延长思考时间 */
function extendTurnTimer(room, extraMs = 10000) {
  const player = getCurrentPlayer(room);
  if (!player || !room.settings.timerEnabled) return false;
  if (room.gameState.status !== 'playing' || room.gameState.bettingRound === 'showdown') return false;
  // 离线中不允许自己点延长（回连后可延）
  if (player.disconnected) return false;
  const now = Date.now();
  const base = Math.max(now, room.gameState.timerEnd || now);
  room.gameState.timerEnd = base + extraMs;
  clearTurnTimer(room);
  const remaining = Math.max(0, room.gameState.timerEnd - now);
  room.turnTimer = setTimeout(() => autoActOnTimeout(room), remaining);
  emitTurnTimer(room, player);
  return true;
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function applyPlayerRebuy(room, player, amount) {
  if (!player?.userId) return { ok: false, error: '无效玩家' };
  const fresh = db.getUserById(player.userId);
  if (!fresh || fresh.chips < amount) {
    return { ok: false, error: `账户筹码不足，需要 ${amount}` };
  }
  db.adjustChips(fresh.id, -amount);
  player.sessionBuyIn = (player.sessionBuyIn || 0) + amount;
  const inBetting = room.gameState.status === 'playing'
    && room.gameState.bettingRound !== 'showdown';
  if (inBetting) {
    // 下注中补码：先扣账户，下一手再入桌面筹码（避免当街直接使用）
    player.pendingRebuy = (player.pendingRebuy || 0) + amount;
    player.hasRebought = true;
    return { ok: true, pending: true, wallet: db.getUserById(fresh.id).chips };
  }
  player.chips = (player.chips || 0) + amount;
  player.hasRebought = true;
  player.isSittingOut = false;
  return { ok: true, wallet: db.getUserById(fresh.id).chips };
}

function getCurrentPlayer(room) {
  return Array.from(room.players.values()).find(p => p.seatIndex === room.gameState.currentPlayerIndex && !p.folded && !p.allIn);
}

function processAction(playerId, action, amount, opts = {}) {
  const room = Array.from(rooms.values()).find(r => r.players.has(playerId));
  if (!room) return;
  const player = room.players.get(playerId);
  if (!player) return;
  if (player.seatIndex !== room.gameState.currentPlayerIndex) {
    io.to(playerId).emit('error-msg', 'It is not your turn.');
    return;
  }
  if (player.folded || player.allIn) {
    io.to(playerId).emit('error-msg', 'You cannot act.');
    return;
  }
  clearTurnTimer(room);
  const markVoluntary = () => {
    if (!opts.auto) {
      player.actedVoluntarilyThisHand = true;
      player.idleHands = 0;
    }
  };
  if (action === 'fold') {
    player.folded = true;
    player.hasActed = true;
    markVoluntary();
    logHandAction(room, player, 'fold', { amount: 0 });
  } else if (action === 'check') {
    if (player.currentBet < room.gameState.currentBet) {
      io.to(playerId).emit('error-msg', 'You cannot check — there is a bet to call.');
      startTurnTimer(room);
      return;
    }
    player.hasActed = true;
    markVoluntary();
    logHandAction(room, player, 'check', { amount: 0 });
  } else if (action === 'call') {
    const callAmount = room.gameState.currentBet - player.currentBet;
    const actualCall = Math.min(callAmount, player.chips);
    player.chips -= actualCall;
    player.currentBet += actualCall;
    player.totalBet += actualCall;
    if (player.chips === 0) player.allIn = true;
    player.hasActed = true;
    markVoluntary();
    logHandAction(room, player, player.allIn ? 'allin' : 'call', { amount: actualCall });
  } else if (action === 'raise' || action === 'allin') {
    let totalRequired;
    const maxTotal = player.currentBet + player.chips;
    if (action === 'allin') {
      totalRequired = maxTotal;
    } else {
      totalRequired = parseInt(amount, 10) || 0;
      if (totalRequired > maxTotal) totalRequired = maxTotal;
    }
    if (totalRequired <= player.currentBet) {
      io.to(playerId).emit('error-msg', 'Invalid raise amount.');
      startTurnTimer(room);
      return;
    }
    if (totalRequired <= room.gameState.currentBet) {
      const callPortion = Math.min(player.chips, room.gameState.currentBet - player.currentBet);
      player.chips -= callPortion;
      player.currentBet += callPortion;
      player.totalBet += callPortion;
      if (player.chips === 0) player.allIn = true;
      player.hasActed = true;
      markVoluntary();
      logHandAction(room, player, player.allIn ? 'allin' : 'call', { amount: callPortion });
      checkRoundComplete(room);
      return;
    }
    const prevBet = room.gameState.currentBet;
    const raiseDiff = totalRequired - player.currentBet;
    if (raiseDiff > player.chips) {
      io.to(playerId).emit('error-msg', 'You don\'t have enough chips for that raise.');
      startTurnTimer(room);
      return;
    }
    const raiseAmount = totalRequired - prevBet;
    const isShove = totalRequired >= maxTotal;
    // 非全下加注必须达到最小加注额
    if (!isShove && raiseAmount < (room.gameState.minRaise || room.settings.bigBlind)) {
      io.to(playerId).emit('error-msg', `加注至少 ${room.gameState.minRaise || room.settings.bigBlind}`);
      startTurnTimer(room);
      return;
    }
    player.chips -= raiseDiff;
    player.currentBet = totalRequired;
    player.totalBet += raiseDiff;
    if (raiseAmount >= room.gameState.minRaise) {
      room.gameState.minRaise = raiseAmount;
      room.gameState.lastRaise = raiseAmount;
      room.gameState.currentBet = totalRequired;
      Array.from(room.players.values()).forEach(p => {
        if (p.id !== player.id && !p.folded && !p.allIn) p.hasActed = false;
      });
    } else {
      // 不足以再开一轮的全下加注：仍抬高需跟注额，但不重置他人 hasActed 以外的逻辑——未跟平者仍需行动
      room.gameState.currentBet = totalRequired;
    }
    if (player.chips === 0) player.allIn = true;
    player.hasActed = true;
    markVoluntary();
    const actName = player.allIn ? 'allin' : 'raise';
    logHandAction(room, player, actName, { amount: raiseDiff, raiseBy: Math.max(0, raiseAmount) });
  }
  checkRoundComplete(room);
}

function checkRoundComplete(room) {
  const activePlayers = Array.from(room.players.values()).filter(p => !p.folded && !p.isSittingOut);
  const playersWhoCanAct = activePlayers.filter(p => !p.allIn);
  const roundOver = playersWhoCanAct.length === 0
    || playersWhoCanAct.every(p => p.hasActed && p.currentBet === room.gameState.currentBet);
  const onlyOneLeft = activePlayers.length <= 1;
  if (roundOver || onlyOneLeft) {
    const pots = calculatePots(Array.from(room.players.values()));
    room.gameState.pots = pots;
    Array.from(room.players.values()).forEach(p => p.currentBet = 0);
    room.gameState.currentBet = 0;
    room.gameState.minRaise = room.settings.bigBlind;
    if (onlyOneLeft) {
      return endHand(room);
    }
    advanceRound(room);
  } else {
    moveToNextPlayer(room);
    // 下一位若找不到可行动者，避免空转计时器卡死
    if (!getCurrentPlayer(room)) {
      beginAllInRunoutFromStreet(room);
      return;
    }
    startTurnTimer(room);
  }
  broadcastState(room);
}

/** 从 fromSeat 顺时针找下一位仍在手且可行动（未弃牌/未坐出/未全下）的玩家座位 */
function findNextSeatClockwise(room, fromSeat, { canActOnly = true } = {}) {
  const max = Math.max(2, room.settings.maxPlayers || 9);
  const players = Array.from(room.players.values());
  for (let i = 1; i <= max; i++) {
    const seat = (fromSeat + i + max * 4) % max;
    const p = players.find(x => x.seatIndex === seat);
    if (!p || p.folded || p.isSittingOut) continue;
    if (canActOnly && p.allIn) continue;
    return seat;
  }
  return -1;
}

function moveToNextPlayer(room) {
  const next = findNextSeatClockwise(room, room.gameState.currentPlayerIndex, { canActOnly: true });
  if (next >= 0) room.gameState.currentPlayerIndex = next;
}

const ALLIN_STREET_DELAY_MS = 1400;

function clearAllInRunout(room) {
  if (!room) return;
  if (room._allInRunoutTimer) {
    clearTimeout(room._allInRunoutTimer);
    room._allInRunoutTimer = null;
  }
}

function dealNextStreet(room) {
  if (room.gameState.bettingRound === 'preflop') {
    room.gameState.bettingRound = 'flop';
    room.gameState.deck.pop();
    for (let i = 0; i < 3; i++) room.gameState.communityCards.push(room.gameState.deck.pop());
    return 'flop';
  }
  if (room.gameState.bettingRound === 'flop') {
    room.gameState.bettingRound = 'turn';
    room.gameState.deck.pop();
    room.gameState.communityCards.push(room.gameState.deck.pop());
    return 'turn';
  }
  if (room.gameState.bettingRound === 'turn') {
    room.gameState.bettingRound = 'river';
    room.gameState.deck.pop();
    room.gameState.communityCards.push(room.gameState.deck.pop());
    return 'river';
  }
  return null;
}

function scheduleAllInRunout(room) {
  clearAllInRunout(room);
  room._allInRunoutTimer = setTimeout(() => {
    room._allInRunoutTimer = null;
    if (!rooms.has(room.id) || room._settling) return;
    if (room.gameState.status !== 'playing') return;
    if (room.gameState.bettingRound === 'showdown') return;
    if (room.gameState.bettingRound === 'river') {
      endHand(room);
      return;
    }
    advanceRound(room);
    broadcastState(room);
  }, ALLIN_STREET_DELAY_MS);
}

function advanceRound(room) {
  clearAllInRunout(room);
  clearTurnTimer(room);

  if (room.gameState.bettingRound === 'river') {
    return endHand(room);
  }

  const street = dealNextStreet(room);
  if (!street) return endHand(room);

  Array.from(room.players.values()).forEach(p => { p.hasActed = false; });
  const activePlayers = Array.from(room.players.values()).filter(p => !p.folded && !p.isSittingOut);
  const canActCount = activePlayers.filter(p => !p.allIn).length;

  if (canActCount > 1) {
    // 翻后首位：
    // - Heads-up：大盲先动（庄家=小盲后动）
    // - 多人：庄家左侧第一位可行动者（通常小盲）
    let firstToActIdx = -1;
    if (room.gameState.headsUp) {
      const bbSeat = room.gameState.bbSeat;
      const bb = activePlayers.find(p => p.seatIndex === bbSeat && !p.allIn);
      firstToActIdx = bb
        ? bb.seatIndex
        : findNextSeatClockwise(room, room.gameState.dealerIndex, { canActOnly: true });
    } else {
      firstToActIdx = findNextSeatClockwise(room, room.gameState.dealerIndex, { canActOnly: true });
    }
    if (firstToActIdx >= 0) room.gameState.currentPlayerIndex = firstToActIdx;
    startTurnTimer(room);
    return;
  }

  // 全下摊牌：逐街发公共牌，街与街之间留间隔
  room.gameState.currentPlayerIndex = -1;
  room.gameState.timerEnd = 0;
  emitToRoom(room, 'street-dealt', {
    street,
    communityCards: room.gameState.communityCards,
    delayMs: ALLIN_STREET_DELAY_MS
  });
  scheduleAllInRunout(room);
}

function endHand(room) {
  // 防止全下跑街 / 超时等路径重复结算导致筹码翻倍发放
  if (room._handSettled) return;
  room._handSettled = true;
  clearTurnTimer(room);
  clearAllInRunout(room);
  room.gameState.bettingRound = 'showdown';
  // 一直在池里（未弃牌）的玩家默认自动秀两张；弃牌者可选手动秀
  for (const p of room.players.values()) {
    if ((p.holeCards || []).length >= 2 && !p.folded) {
      p.shownHoleMask = [true, true];
    } else {
      p.shownHoleMask = [false, false];
    }
  }
  const pots = calculatePots(Array.from(room.players.values()));
  const activePlayers = Array.from(room.players.values()).filter(p => !p.folded);
  const results = [];
  let lastWinners = null; // track previous pot's winners so orphan pots fall back to them
  pots.forEach(pot => {
    if (!pot.amount) return;
    // 无资格玩家的池：优先退回贡献者，避免筹码蒸发
    if (!pot.eligible || pot.eligible.length === 0) {
      const refundIds = pot.refundIds || Array.from(room.players.values())
        .filter(p => p.totalBet > 0).map(p => p.id);
      const refundPlayers = refundIds.map(id => room.players.get(id)).filter(Boolean);
      // 按各自投入退回，禁止均分错账
      refundPlayers.forEach(c => {
        c.chips += c.totalBet || 0;
      });
      return;
    }
    const eligiblePlayers = activePlayers.filter(p => pot.eligible.includes(p.id));
    if (eligiblePlayers.length === 0) {
      if (lastWinners && lastWinners.length > 0) {
        const share = Math.floor(pot.amount / lastWinners.length);
        let remainder = pot.amount - share * lastWinners.length;
        lastWinners.forEach(w => {
          const amt = share + (remainder-- > 0 ? 1 : 0);
          w.player.chips += amt;
          results.push({
            playerId: w.player.id,
            playerName: w.player.name,
            amount: amt,
            hand: ''
          });
        });
      } else {
        const contributors = Array.from(room.players.values()).filter(p => p.totalBet > 0);
        if (contributors.length > 0) {
          const share = Math.floor(pot.amount / contributors.length);
          let remainder = pot.amount - share * contributors.length;
          contributors.forEach(c => {
            c.chips += share + (remainder-- > 0 ? 1 : 0);
          });
        }
      }
      return;
    }
    if (eligiblePlayers.length === 1) {
      const w = eligiblePlayers[0];
      w.chips += pot.amount;
      results.push({
        playerId: w.id,
        playerName: w.name,
        amount: pot.amount,
        hand: ''
      });
      lastWinners = [{ player: w, hand: { name: '' } }];
      return;
    }
    const evaluated = eligiblePlayers.map(p => ({
      player: p,
      hand: bestHand([...p.holeCards, ...room.gameState.communityCards])
    }));
    evaluated.sort((a,b) => compareHands(b.hand, a.hand));
    const bestEval = evaluated[0].hand;
    const winners = evaluated.filter(e => compareHands(e.hand, bestEval) === 0);
    const baseShare = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - baseShare * winners.length;
    winners.forEach(w => {
      const amt = baseShare + (remainder-- > 0 ? 1 : 0);
      w.player.chips += amt;
      results.push({
        playerId: w.player.id,
        playerName: w.player.name,
        amount: amt,
        hand: w.hand.name
      });
    });
    lastWinners = winners;
  });
  const handLog = finalizeHandLog(room, results);
  broadcastState(room);
  persistRoomNow(room);
  room.players.forEach((_, sid) => {
    if (!isLiveSocketId(sid)) return;
    const u = (() => {
      try {
        const sock = io.sockets.sockets.get(sid);
        return sock?.data?.user?.id || null;
      } catch (_) { return null; }
    })();
    io.to(sid).emit('hand-ended', {
      state: room.getPublicState(sid),
      results,
      handHistoryCount: room.handLogs.length,
      handLog: sanitizeHandLogForViewer(handLog, u)
    });
  });
  room.spectators.forEach(sid => {
    const sock = io.sockets.sockets.get(sid);
    const u = sock?.data?.user?.id || null;
    io.to(sid).emit('hand-ended', {
      state: room.getPublicState(sid),
      results,
      handHistoryCount: room.handLogs.length,
      handLog: sanitizeHandLogForViewer(handLog, u)
    });
  });

  // 持久化本手战绩
  try {
    const potTotal = handLog?.potTotal
      || (room.gameState.pots || []).reduce((s, p) => s + p.amount, 0)
      || results.reduce((s, r) => s + (r.amount || 0), 0);
    const winnerIds = new Set(results.map(r => r.playerId));
    const handPlayers = Array.from(room.players.values()).map(p => ({
      userId: p.userId,
      nickname: p.name,
      seatIndex: p.seatIndex,
      profit: p.chips - (p.handStartChips || 0),
      won: winnerIds.has(p.id),
      folded: !!p.folded,
      holeCards: p.holeCards || []
    }));
    if (room.sessionId) {
      db.recordHand({
        sessionId: room.sessionId,
        roomCode: room.id,
        handNumber: room.gameState.handNumber,
        communityCards: room.gameState.communityCards,
        potTotal,
        results: results.map(r => {
          const p = room.players.get(r.playerId);
          return {
            userId: p?.userId || null,
            nickname: p?.name || '',
            amount: r.amount,
            hand: r.hand
          };
        }),
        players: handPlayers,
        actions: (handLog?.actions || []).map(a => ({
          street: a.street,
          userId: a.userId || null,
          name: a.name,
          seatIndex: a.seatIndex,
          action: a.action,
          amount: a.amount || 0,
          raiseBy: a.raiseBy || 0,
          allIn: !!a.allIn
        }))
      });
    }
  } catch (err) {
    console.error('Failed to record hand:', err);
  }

  Array.from(room.players.values()).forEach(p => {
    if (p.chips === 0) {
      p.isSittingOut = true;
    }
  });
  // 连续空闲 → 自动暂离 / 离座；处理手动暂离、退出座位
  applyIdleAndSitOutRules(room);
  if (!rooms.has(room.id)) return;

  // 本手结束后：仅「不预期重连 / 主动离座」移入 away；短断线保留占座以便下一手续打
  for (const [sid, p] of [...room.players.entries()]) {
    if (p.disconnected && p.userId) {
      if (p.sitOutAfterHand || !p.expectReconnect) {
        if (p.sitOutAfterHand) p.isSittingOut = true;
        room.rebuyRequests.delete(sid);
        room.players.delete(sid);
        room.awayPlayers.set(p.userId, p);
      }
    }
  }
  // 本手结束后稍作停顿，方便看清公共牌与结算，再开下一手
  scheduleNextHand(room, AUTO_NEXT_HAND_MS);
}

/** 一手结束到下一手开局的间隔（看清公共牌 / 赢牌结果 / 可选秀牌） */
const AUTO_NEXT_HAND_MS = 6500;

function countPotentialNextHandPlayers(room) {
  let n = 0;
  room.players.forEach(p => {
    if (p.chips <= 0) return;
    if (p.hasRebought || p.pendingJoin || !p.isSittingOut) n++;
  });
  n += room.joinQueue.length;
  return n;
}

function emitToRoom(room, event, payload) {
  room.players.forEach((_, sid) => {
    if (!isLiveSocketId(sid)) return;
    io.to(sid).emit(event, payload);
  });
  room.spectators.forEach(sid => io.to(sid).emit(event, payload));
}

function scheduleNextHand(room, delayMs = AUTO_NEXT_HAND_MS) {
  if (room._nextHandTimer) {
    clearTimeout(room._nextHandTimer);
    room._nextHandTimer = null;
  }
  if (room._settling) return;
  if (room.gameState.status !== 'playing') return;
  if (room.gameState.bettingRound !== 'showdown') return;

  // 时间到 / 待结算：不再开下一手
  if (room.pendingSettle || (room.sessionEndsAt && Date.now() >= room.sessionEndsAt)) {
    settleSession(room, room.pendingSettleReason || 'timeout');
    return;
  }

  if (countPotentialNextHandPlayers(room) < 2) {
    room.gameState.status = 'waiting';
    broadcastState(room);
    emitToRoom(room, 'next-hand-cancelled', { reason: 'need-players' });
    return;
  }

  const startNext = () => {
    room._nextHandTimer = null;
    room._nextHandAt = null;
    if (!rooms.has(room.id) || room._settling) return;
    if (room.pendingSettle || (room.sessionEndsAt && Date.now() >= room.sessionEndsAt)) {
      settleSession(room, room.pendingSettleReason || 'timeout');
      return;
    }
    if (room.gameState.status !== 'playing') return;
    if (room.gameState.bettingRound !== 'showdown') return;

    processJoinQueue(room);
    startHand(room);
    broadcastState(room);
  };

  if (delayMs <= 0) {
    room._nextHandAt = Date.now();
    startNext();
    return;
  }

  const startAt = Date.now() + delayMs;
  room._nextHandAt = startAt;
  emitToRoom(room, 'next-hand-scheduled', { delayMs, startAt });
  room._nextHandTimer = setTimeout(startNext, delayMs);
}
io.use((socket, next) => {
  const user = auth.socketAuth(socket);
  if (!user) return next(new Error('UNAUTHORIZED'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  console.log(`User connected: ${socket.id} (${user.username})`);
  socket.emit('auth-ok', { user: db.publicUser(user) });
  // 刷新/断线重连：自动回到原座位
  tryAutoRejoin(socket, user);

  socket.on('create-room', (data) => {
    const fresh = db.getUserById(user.id);
    if (!fresh || fresh.status === 'banned') return socket.emit('error-msg', '账号无效');
    if (findRoomByUserId(fresh.id)) {
      if (tryAutoRejoin(socket, fresh)) return;
      return socket.emit('error-msg', '你已在其他牌局中，请先回到原房间或等待结算');
    }
    const nickname = fresh.nickname;
    const roomId = generateRoomCode();
    const sessionMinutesRaw = parseInt(data.sessionMinutes);
    // 1–24 小时，步长 30 分钟
    let sessionMinutes = 60;
    if (Number.isFinite(sessionMinutesRaw)
        && sessionMinutesRaw >= 60
        && sessionMinutesRaw <= 1440
        && sessionMinutesRaw % 30 === 0) {
      sessionMinutes = sessionMinutesRaw;
    }
    const bigBlind = Math.max(1, parseInt(data.bigBlind) || 2);
    const smallBlind = Math.max(1, parseInt(data.smallBlind) || 1);
    const defaultBuyIn = bigBlind * 100; // 新玩家默认 100 个大盲
    const settings = {
      smallBlind,
      bigBlind,
      maxPlayers: Math.max(2, Math.min(12, parseInt(data.maxPlayers) || 9)),
      startingChips: Math.max(bigBlind, parseInt(data.startingChips) || defaultBuyIn),
      timerSeconds: Math.max(5, Math.min(120, parseInt(data.timerSeconds) || 20)),
      timerEnabled: data.timerEnabled !== undefined ? data.timerEnabled : true,
      rebuysAllowed: data.rebuysAllowed !== undefined ? data.rebuysAllowed : true,
      rebuyNeedsApproval: !!data.rebuyNeedsApproval,
      sessionMinutes
    };
    if (fresh.chips < settings.startingChips) {
      return socket.emit('error-msg', `筹码不足，需要买入 ${settings.startingChips}（当前 ${fresh.chips}）`);
    }
    db.adjustChips(fresh.id, -settings.startingChips);
    const defaultRoomName = `${nickname}的牌局`;
    const sessionId = db.createSession({
      roomCode: roomId,
      roomName: (data.roomName || defaultRoomName).slice(0, 20),
      hostUserId: fresh.id,
      smallBlind: settings.smallBlind,
      bigBlind: settings.bigBlind,
      buyIn: settings.startingChips,
      passwordProtected: !!data.password
    });
    const room = new Room(roomId, socket.id, data.roomName || defaultRoomName, data.password || '', settings, {
      sessionId,
      hostUserId: fresh.id
    });
    const player = new Player(socket.id, nickname, settings.startingChips, 0, fresh.id);
    room.players.set(socket.id, player);
    rooms.set(roomId, room);
    startSessionClock(room);
    socket.join(roomId);
    socket.emit('joined-room', room.getPublicState(socket.id));
    socket.emit('wallet-update', { chips: db.getUserById(fresh.id).chips });
    persistRoomNow(room);
    console.log(`Room created: ${roomId} by ${fresh.username}, session ${sessionMinutes || '∞'} min`);
  });
  
  socket.on('join-room', (data) => {
    const fresh = db.getUserById(user.id);
    if (!fresh || fresh.status === 'banned') return socket.emit('error-msg', '账号无效');
    const room = rooms.get(String(data.roomCode || '').toUpperCase());
    if (!room || room._settling) return socket.emit('error-msg', '房间不存在');
    if (room.password && room.password !== data.password) return socket.emit('error-msg', '房间密码错误');

    // 已在座 / 断线占座 / 暂离：回桌不重新买入
    const seated = Array.from(room.players.values()).find(p => p.userId === fresh.id);
    if (seated && !seated.disconnected) {
      socket.join(room.id);
      socket.emit('joined-room', room.getPublicState(socket.id));
      return;
    }
    if (seated?.disconnected || room.awayPlayers.has(fresh.id)) {
      reclaimPlayer(room, socket, fresh);
      socket.emit('joined-room', room.getPublicState(socket.id));
      socket.emit('wallet-update', { chips: db.getUserById(fresh.id).chips });
      broadcastState(room);
      persistRoomNow(room);
      if (getCurrentPlayer(room)?.id === socket.id && !room.turnTimer) startTurnTimer(room);
      tryResumeHandIfNeeded(room);
      return;
    }
    // 已在其他房间
    const other = findRoomByUserId(fresh.id);
    if (other && other.id !== room.id) {
      return socket.emit('error-msg', `你还在房间 ${other.id} 中，请先回到该房间`);
    }

    const occupied = seatedPlayers(room);
    if (occupied.length >= room.settings.maxPlayers) return socket.emit('error-msg', '房间已满');
    const buyIn = room.settings.startingChips;
    if (fresh.chips < buyIn) {
      return socket.emit('error-msg', `筹码不足，需要买入 ${buyIn}（当前 ${fresh.chips}）`);
    }
    db.adjustChips(fresh.id, -buyIn);
    const seatIndex = Array.from({ length: room.settings.maxPlayers }, (_, i) => i)
      .find(i => !occupied.some(p => p.seatIndex === i));
    const player = new Player(socket.id, fresh.nickname, buyIn, seatIndex, fresh.id);
    // 下注进行中：本手不发牌，下一手自动入局；摊牌间隙/等待中则直接可打下一手
    const inBetting = room.gameState.status === 'playing'
      && room.gameState.bettingRound !== 'showdown';
    if (inBetting) {
      player.isSittingOut = true;
      player.pendingJoin = true;
      player.folded = true;
      socket.emit('join-pending-next-hand', {
        message: '已入座，本手不发牌，下一手自动入局'
      });
    }
    room.players.set(socket.id, player);
    socket.join(room.id);
    if (room.destructionTimeout) {
      clearTimeout(room.destructionTimeout);
      room.destructionTimeout = null;
    }
    socket.emit('joined-room', room.getPublicState(socket.id));
    socket.emit('wallet-update', { chips: db.getUserById(fresh.id).chips });
    broadcastState(room);
    // 若正好在摊牌等待下一手，确保会被算进下一手人数
    if (!inBetting && room.gameState.status === 'playing'
      && room.gameState.bettingRound === 'showdown') {
      tryResumeHandIfNeeded(room);
    }
  });

  socket.on('get-hand-history', (data) => {
    const room = findRoomBySocket(socket.id) || findRoomByUserId(user.id);
    if (!room) return socket.emit('error-msg', '不在房间中');
    const total = room.handLogs.length;
    if (!total) {
      return socket.emit('hand-history-page', { index: -1, total: 0, hand: null });
    }
    let index = data?.index;
    if (index === undefined || index === null || index === 'latest') index = total - 1;
    else index = parseInt(index, 10);
    if (!Number.isFinite(index)) index = total - 1;
    index = Math.max(0, Math.min(total - 1, index));
    socket.emit('hand-history-page', {
      index,
      total,
      hand: sanitizeHandLogForViewer(room.handLogs[index], user.id)
    });
  });

  // 主动离开牌桌 UI：保留座位与筹码，可再次加入
  socket.on('leave-room', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    if (room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
      room.spectatorNames.delete(socket.id);
      room.spectatorUserIds.delete(socket.id);
      room.joinQueue = room.joinQueue.filter(id => id !== socket.id);
      room.joinRequests.delete(socket.id);
      room.rebuyRequests.delete(socket.id);
      socket.leave(room.id);
      socket.emit('left-room');
      broadcastState(room);
      return;
    }
    if (room.players.has(socket.id)) {
      parkPlayer(room, socket.id, { expectReconnect: false });
      socket.leave(room.id);
      socket.emit('left-room');
      broadcastState(room);
    }
  });

  // 留位暂离（本手结束后生效；非下注中立刻生效）
  socket.on('sit-out', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const inBetting = room.gameState.status === 'playing'
      && room.gameState.bettingRound !== 'showdown'
      && !player.folded;
    if (inBetting) {
      player.wantSitOut = true;
      player.wantLeaveSeat = false;
      socket.emit('sit-out-pending', { message: '本手结束后将暂离（留位）' });
    } else {
      player.isSittingOut = true;
      player.wantSitOut = false;
      player.folded = true;
      socket.emit('auto-sit-out', { idleHands: player.idleHands || 0, message: '已暂离（留位）' });
    }
    broadcastState(room);
  });

  // 回桌继续打牌（或取消「本手结束后暂离」）
  socket.on('sit-in', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.chips <= 0 && player.isSittingOut) {
      return socket.emit('error-msg', '筹码不足，请先买入再回桌');
    }
    const wasSittingOut = player.isSittingOut;
    player.isSittingOut = false;
    player.wantSitOut = false;
    player.wantLeaveSeat = false;
    if (wasSittingOut) player.idleHands = 0;
    broadcastState(room);
    tryResumeHandIfNeeded(room);
  });

  // 退出座位：释放座位，筹码回账户，变为观战
  socket.on('leave-seat', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const inBetting = room.gameState.status === 'playing'
      && room.gameState.bettingRound !== 'showdown'
      && !player.folded
      && !player.isSittingOut;
    if (inBetting) {
      player.wantLeaveSeat = true;
      player.wantSitOut = false;
      socket.emit('leave-seat-pending', { message: '本手结束后将离开座位' });
      broadcastState(room);
      return;
    }
    forceLeaveSeat(room, socket.id, 'leave');
    if (rooms.has(room.id)) broadcastState(room);
  });
  
  socket.on('spectate-room', (data) => {
    const fresh = db.getUserById(user.id);
    if (!fresh || fresh.status === 'banned') return socket.emit('error-msg', '账号无效');
    const room = rooms.get(String(data.roomCode || '').toUpperCase());
    if (!room) return socket.emit('error-msg', '房间不存在');
    if (room.password && room.password !== data.password) return socket.emit('error-msg', '房间密码错误');
    room.spectators.add(socket.id);
    room.spectatorNames.set(socket.id, fresh.nickname);
    room.spectatorUserIds.set(socket.id, fresh.id);
    socket.join(room.id);
    if (room.destructionTimeout) {
      clearTimeout(room.destructionTimeout);
      room.destructionTimeout = null;
    }
    socket.emit('joined-room', room.getPublicState(socket.id));
    socket.emit('set-spectator', true);
    broadcastState(room);
  });
  
  socket.on('list-public-rooms', () => {
    socket.emit('public-rooms', getLobbyRooms());
  });
  
  socket.on('start-game', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id) || r.spectators.has(socket.id));
    if (!room || !isHostUser(room, user.id)) return;
    if (room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') {
      return socket.emit('error-msg', '牌局进行中，不能重新开局');
    }
    processJoinQueue(room);
    startGame(room);
    broadcastState(room);
  });

  socket.on('start-next-hand', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id) || r.spectators.has(socket.id));
    if (!room || !isHostUser(room, user.id)) return;
    if (room.gameState.status !== 'playing') return;
    if (room.gameState.bettingRound !== 'showdown') {
      return socket.emit('error-msg', '本手尚未结束，不能开下一手');
    }
    if (room._nextHandTimer) {
      clearTimeout(room._nextHandTimer);
      room._nextHandTimer = null;
    }
    processJoinQueue(room);
    startHand(room);
    broadcastState(room);
  });

  socket.on('request-join', () => {
    const room = Array.from(rooms.values()).find(r => r.spectators.has(socket.id));
    if (!room) return;
    if (!room.joinRequests.has(socket.id)) {
      room.joinRequests.set(socket.id, { name: room.spectatorNames.get(socket.id) || 'Spectator', approved: false });
    }
    socket.emit('join-requested', true);
    broadcastState(room);
  });

  socket.on('cancel-join', () => {
    const room = Array.from(rooms.values()).find(r => r.spectators.has(socket.id));
    if (!room) return;
    room.joinRequests.delete(socket.id);
    room.joinQueue = room.joinQueue.filter(id => id !== socket.id);
    socket.emit('join-requested', false);
    broadcastState(room);
  });

  socket.on('accept-join', (data) => {
    const room = Array.from(rooms.values()).find(r => isHostUser(r, user.id));
    if (!room) return;
    const req = room.joinRequests.get(data.spectatorId);
    if (req) {
      req.approved = true;
      if (!room.joinQueue.includes(data.spectatorId)) {
        room.joinQueue.push(data.spectatorId);
      }
      io.to(data.spectatorId).emit('join-status', { status: 'approved' });
      broadcastState(room);
    }
  });

  socket.on('decline-join', (data) => {
    const room = Array.from(rooms.values()).find(r => isHostUser(r, user.id));
    if (!room) return;
    room.joinRequests.delete(data.spectatorId);
    room.joinQueue = room.joinQueue.filter(id => id !== data.spectatorId);
    io.to(data.spectatorId).emit('join-status', { status: 'declined' });
    broadcastState(room);
  });

  socket.on('extend-timer', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    const player = getCurrentPlayer(room);
    if (!player || player.id !== socket.id) {
      return socket.emit('error-msg', '只有当前行动玩家可以加时');
    }
    if (!extendTurnTimer(room, 10000)) {
      return socket.emit('error-msg', '当前无法加时');
    }
  });

  socket.on('rebuy-request', (data) => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !room.settings.rebuysAllowed) return;
    const amount = Math.max(1, parseInt(data.amount) || room.settings.startingChips);
    // 免审核：立即到账
    if (!room.settings.rebuyNeedsApproval) {
      const result = applyPlayerRebuy(room, player, amount);
      if (!result.ok) return socket.emit('error-msg', result.error);
      socket.emit('rebuy-result', { approved: true, amount });
      socket.emit('wallet-update', { chips: result.wallet });
      broadcastState(room);
      return;
    }
    const fresh = player.userId ? db.getUserById(player.userId) : null;
    if (fresh && fresh.chips < amount) {
      return socket.emit('error-msg', `账户筹码不足，需要 ${amount}`);
    }
    room.rebuyRequests.set(socket.id, { name: player.name, amount });
    socket.emit('rebuy-pending', true);
    broadcastState(room);
  });

  socket.on('cancel-rebuy', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    room.rebuyRequests.delete(socket.id);
    socket.emit('rebuy-pending', false);
    broadcastState(room);
  });

  socket.on('host-rebuy', (data) => {
    const room = Array.from(rooms.values()).find(r => isHostUser(r, user.id) && r.players.has(socket.id));
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !room.settings.rebuysAllowed) return;
    const amount = Math.max(1, parseInt(data.amount) || room.settings.startingChips);
    const result = applyPlayerRebuy(room, player, amount);
    if (!result.ok) return socket.emit('error-msg', result.error);
    socket.emit('rebuy-result', { approved: true, amount });
    socket.emit('wallet-update', { chips: result.wallet });
    broadcastState(room);
  });

  socket.on('approve-rebuy', (data) => {
    const room = Array.from(rooms.values()).find(r => isHostUser(r, user.id));
    if (!room) return;
    const req = room.rebuyRequests.get(data.playerId);
    if (!req) return;
    const amount = Math.max(1, parseInt(data.amount) || req.amount);
    const player = room.players.get(data.playerId);
    if (player?.userId) {
      const result = applyPlayerRebuy(room, player, amount);
      if (!result.ok) return socket.emit('error-msg', result.error);
      io.to(data.playerId).emit('wallet-update', { chips: result.wallet });
    } else if (player) {
      player.chips = amount;
      player.sessionBuyIn = (player.sessionBuyIn || 0) + amount;
      player.hasRebought = true;
      player.isSittingOut = false;
    }
    room.rebuyRequests.delete(data.playerId);
    io.to(data.playerId).emit('rebuy-result', { approved: true, amount });
    broadcastState(room);
  });

  socket.on('decline-rebuy', (data) => {
    const room = Array.from(rooms.values()).find(r => isHostUser(r, user.id));
    if (!room) return;
    room.rebuyRequests.delete(data.playerId);
    io.to(data.playerId).emit('rebuy-result', { approved: false });
    broadcastState(room);
  });

  socket.on('end-game', () => {
    const room = Array.from(rooms.values()).find(r => isHostUser(r, user.id));
    if (!room) return;
    // 正在打牌：标记本手结束后结算；否则立即结算
    if (room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') {
      room.pendingSettle = true;
      room.pendingSettleReason = 'host';
      emitToRoom(room, 'session-ending', {
        message: '房主结束牌局，本手结束后进入结算',
        sessionEndsAt: Date.now()
      });
      return;
    }
    if (room._nextHandTimer) {
      clearTimeout(room._nextHandTimer);
      room._nextHandTimer = null;
    }
    settleSession(room, 'host');
  });
  
  /** 摊牌阶段秀牌：indexes 为 [0]/[1]/[0,1] 或 'all'；弃牌者手动秀，池内已自动秀 */
  socket.on('show-cards', (data) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    if (room.gameState.status !== 'playing' || room.gameState.bettingRound !== 'showdown') return;
    const player = room.players.get(socket.id);
    if (!player || !(player.holeCards || []).length) return;

    let indexes = [];
    if (data === 'all' || data?.indexes === 'all' || data?.all) {
      indexes = player.holeCards.map((_, i) => i);
    } else if (Array.isArray(data?.indexes)) {
      indexes = data.indexes.map(n => parseInt(n, 10)).filter(n => n >= 0 && n < player.holeCards.length);
    } else if (typeof data?.index === 'number') {
      indexes = [data.index];
    } else if (typeof data === 'number') {
      indexes = [data];
    }
    if (!indexes.length) return;

    if (!Array.isArray(player.shownHoleMask)) player.shownHoleMask = [false, false];
    for (const i of indexes) player.shownHoleMask[i] = true;

    const lastLog = room.handLogs[room.handLogs.length - 1];
    if (lastLog) {
      const row = lastLog.players.find(r => r.playerId === player.id
        || (player.userId && r.userId === player.userId));
      if (row) {
        row.showed = player.shownHoleMask.some(Boolean);
        row.shownHoleMask = [...player.shownHoleMask];
        row.holeCards = [...(player.holeCards || [])];
      }
    }

    broadcastState(room);
  });

  socket.on('action', (data) => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    processAction(socket.id, data.action, data.amount);
  });
  
  socket.on('send-chat', (msg) => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id) || r.spectators.has(socket.id));
    if (!room) return;
    if (room.spectators.has(socket.id)) return;
    if (typeof msg !== 'string') return;
    const trimmed = msg.trim().slice(0, 500);
    if (!trimmed) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const message = {
      sender: player.name,
      message: trimmed,
      timestamp: Date.now(),
      isSpectator: false,
      playerId: socket.id,
      seatIndex: player.seatIndex,
      kind: 'text'
    };
    room.chat.push(message);
    room.players.forEach((_, sid) => io.to(sid).emit('chat-message', message));
    room.spectators.forEach(sid => io.to(sid).emit('chat-message', message));
  });

  // 自研表情白名单（Unicode，非第三方版权素材）
  const ALLOWED_EMOJIS = new Set([
    '😂','🤣','😆','😅','😏','😎','🤩','🥳','😮','🫡',
    '😍','🥰','😘','😭','😢','😤','😠','🤬','😱','🤯','😳','🥵',
    '👍','👎','👏','💪','🙏','🤝','✌️','🤞','👀','🤔','😴','🥱',
    '🔥','💀','👻','💩','🤡','😈','🤖','💯','⭐','✨','🎉','💔','❤️','❤','💰','🃏','🎯',
    '🏆','🍾','🙈','🎲'
  ]);
  function normalizeEmote(raw) {
    return String(raw || '').normalize('NFC').replace(/\uFE0F/g, '').trim();
  }
  socket.on('emoji', (emoji) => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    const raw = typeof emoji === 'string' ? emoji.trim().slice(0, 16) : '';
    if (!raw) return;
    const norm = normalizeEmote(raw);
    const allowed = ALLOWED_EMOJIS.has(raw) || ALLOWED_EMOJIS.has(norm)
      || [...ALLOWED_EMOJIS].some(e => normalizeEmote(e) === norm);
    if (!allowed) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const payload = {
      playerId: socket.id,
      seatIndex: player.seatIndex,
      emoji: raw,
      sender: player.name,
      kind: 'emoji'
    };
    room.players.forEach((_, sid) => io.to(sid).emit('emoji-received', payload));
    room.spectators.forEach(sid => io.to(sid).emit('emoji-received', payload));
  });
  
  socket.on('host-action', (data) => {
    const room = Array.from(rooms.values()).find(r => isHostUser(r, user.id));
    if (!room) return;
    if (data.type === 'kick') {
      const target = room.players.get(data.playerId);
      if (target) {
        const inBetting = room.gameState.status === 'playing'
          && room.gameState.bettingRound !== 'showdown';
        if (inBetting) {
          // 局中踢人：本手保留在 players 以保住死码，结束后再离座结算
          const wasCurrent = room.gameState.currentPlayerIndex === target.seatIndex && !target.folded;
          if (wasCurrent) {
            processAction(data.playerId, 'fold', 0);
          } else if (!target.folded) {
            target.folded = true;
            target.hasActed = true;
            logHandAction(room, target, 'fold', { amount: 0 });
            const stillIn = Array.from(room.players.values()).filter(p => !p.folded && !p.isSittingOut);
            if (stillIn.length <= 1) endHand(room);
            else if (!getCurrentPlayer(room)) {
              moveToNextPlayer(room);
              startTurnTimer(room);
            }
          }
          target.wantLeaveSeat = true;
          target.isSittingOut = true;
          io.to(data.playerId).emit('kicked', { toSpectator: true, afterHand: true });
          broadcastState(room);
        } else {
          forceLeaveSeat(room, data.playerId, 'kick');
          if (rooms.has(room.id)) broadcastState(room);
        }
      } else if (room.spectators.has(data.playerId)) {
        // Kick a spectator — they're removed entirely
        io.to(data.playerId).emit('kicked', { toSpectator: false });
        room.spectators.delete(data.playerId);
        room.spectatorNames.delete(data.playerId);
        room.joinQueue = room.joinQueue.filter(id => id !== data.playerId);
        room.joinRequests.delete(data.playerId);
        broadcastState(room);
      }
    } else if (data.type === 'edit-chips') {
      // Allow editing when game hasn't started, OR between hands (bettingRound === 'showdown')
      if (room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') return;
      const target = room.players.get(data.playerId);
      if (target) {
        target.chips = Math.max(0, parseInt(data.amount));
        // If chips set to > 0, clear sitting-out so they can play next hand
        if (target.chips > 0) {
          target.isSittingOut = false;
        }
        broadcastState(room);
      }
    } else if (data.type === 'change-password') {
      room.password = data.password;
      socket.emit('state-update', room.getPublicState(socket.id));
    } else if (data.type === 'toggle-rebuys') {
      room.settings.rebuysAllowed = !room.settings.rebuysAllowed;
      broadcastState(room);
    } else if (data.type === 'toggle-rebuy-approval') {
      room.settings.rebuyNeedsApproval = !room.settings.rebuyNeedsApproval;
      broadcastState(room);
    } else if (data.type === 'change-max-players') {
      const newMax = Math.max(2, Math.min(12, parseInt(data.amount)));
      const seated = seatedPlayers(room).length;
      if (newMax < seated) {
        return socket.emit('error-msg', `Cannot reduce max players below the current player count (${seated}).`);
      }
      room.settings.maxPlayers = newMax;
      broadcastState(room);
    } else if (data.type === 'rebuy') {
      const target = room.players.get(data.playerId);
      if (target && room.settings.rebuysAllowed) {
        const result = applyPlayerRebuy(room, target, room.settings.startingChips);
        if (result.ok) broadcastState(room);
      }
    } else if (data.type === 'toggle-timer') {
      room.settings.timerEnabled = !room.settings.timerEnabled;
      if (!room.settings.timerEnabled) {
        clearTurnTimer(room);
        room.gameState.timerEnd = 0;
      } else if (room.settings.timerEnabled && room.gameState.status === 'playing') {
        startTurnTimer(room);
      }
      broadcastState(room);
    } else if (data.type === 'change-timer-duration') {
      const dur = Math.max(5, Math.min(120, parseInt(data.amount)));
      room.settings.timerSeconds = dur;
      if (room.settings.timerEnabled && room.gameState.status === 'playing') {
        startTurnTimer(room);
      }
      broadcastState(room);
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    if (room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
      room.spectatorNames.delete(socket.id);
      room.spectatorUserIds.delete(socket.id);
      room.joinQueue = room.joinQueue.filter(id => id !== socket.id);
      room.joinRequests.delete(socket.id);
      room.rebuyRequests.delete(socket.id);
    }
    if (room.players.has(socket.id)) {
      // 断线/刷新：保留座位与筹码，等待自动回连；不结算、不解散
      parkPlayer(room, socket.id, { expectReconnect: true });
    }
    broadcastState(room);
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get(['/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 定期把脏房间写入 SQLite，重启后可恢复
setInterval(() => {
  for (const room of rooms.values()) {
    if (room._dirty && !room._settling) persistRoomNow(room);
  }
}, 2000);

restoreRoomsFromDisk();

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Active rooms in memory: ${rooms.size}`);
  if (process.argv.includes('--test')) {
    console.log('--- RUNNING IN TEST MODE ---');
    const testRoomId = 'TEST01';
    const settings = { smallBlind: 10, bigBlind: 20, maxPlayers: 6, startingChips: 1000, timerSeconds: 1, timerEnabled: true, rebuysAllowed: true };
    const room = new Room(testRoomId, 'bot0', 'Test Room', '', settings);
    rooms.set(testRoomId, room);
    for(let i=0; i<6; i++) {
      const botId = `bot${i}`;
      const player = new Player(botId, `Bot ${i+1}`, 1000, i);
      room.players.set(botId, player);
    }
    let handsPlayed = 0;
    const maxHands = 15;
    const runBotGame = () => {
      if (handsPlayed >= maxHands) {
        console.log('--- TEST COMPLETE ---');
        process.exit(0);
        return;
      }
      if (room.gameState.status === 'waiting') {
        startGame(room);
      }
      const playBotTurns = () => {
        const currentPlayer = getCurrentPlayer(room);
        if (!currentPlayer) { setTimeout(runBotGame, 10); return; }
        if (room.gameState.status !== 'playing') { setTimeout(runBotGame, 10); return; }
        const callAmount = room.gameState.currentBet - currentPlayer.currentBet;
        let action = 'fold';
        let amount = 0;
        const rand = Math.random();
        if (callAmount === 0) {
          action = rand < 0.7 ? 'check' : 'raise';
          amount = room.gameState.currentBet + room.settings.bigBlind;
        } else {
          if (rand < 0.3) action = 'fold';
          else if (rand < 0.8) action = 'call';
          else { action = 'raise'; amount = room.gameState.currentBet + room.settings.bigBlind; }
        }
        processAction(currentPlayer.id, action, amount);
        if (room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') {
          setTimeout(playBotTurns, 0);
        } else {
          handsPlayed++;
          console.log(`Hand ${handsPlayed} finished. Pot: ${room.gameState.pots.reduce((s,p)=>s+p.amount,0)}`);
          setTimeout(runBotGame, 10);
        }
      };
      setTimeout(playBotTurns, 10);
    };
    console.log('Starting 15 hand simulation...');
    runBotGame();
  }
});