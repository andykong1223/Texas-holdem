const socket = io({ autoConnect: false });
let currentRoom = null;
let mySocketId = null;
let isSpectator = false;
let soundEnabled = true;
let audioCtx = null;
let timerInterval = null;
let activeTimerEnd = 0;
let activeTimerInitialLeft = 0;
let nextHandInterval = null;
let hasRequestedJoin = false;
let rebuyPending = false;
let lastRequestCount = 0; // for notification sound
let accountChips = null;
let sessionClockTimer = null;

const NICKNAME_KEY = 'holdem_nickname';
const pendingInvite = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    return (params.get('room') || params.get('code') || '').trim().toUpperCase();
  } catch (_) {
    return '';
  }
})();

function connectGameSocket(token) {
  if (!token) return;
  socket.auth = { token };
  if (socket.connected) {
    socket.disconnect();
  }
  socket.connect();
}

socket.on('connect_error', (err) => {
  if (String(err?.message || '').includes('UNAUTHORIZED')) {
    if (window.App) window.App.onAuthRequired('登录已失效，请重新登录');
  }
});

socket.on('auth-ok', (data) => {
  if (data?.user) {
    accountChips = data.user.chips;
    if (window.App) window.App.onWalletUpdate(data.user);
  }
});

socket.on('wallet-update', (data) => {
  if (typeof data?.chips === 'number') {
    accountChips = data.chips;
    if (window.App) window.App.onWalletUpdate({ chips: data.chips });
  }
});

// -------------------------
// SECURITY: HTML escaping to prevent XSS
// -------------------------
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getSavedNickname() {
  try { return localStorage.getItem(NICKNAME_KEY) || ''; } catch (_) { return ''; }
}

function saveNickname(name) {
  try { if (name) localStorage.setItem(NICKNAME_KEY, name); } catch (_) {}
}

function fillNicknameInputs() {
  const nick = getSavedNickname();
  ['host-nickname', 'join-nickname', 'join-modal-nickname'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = nick;
  });
}

function ensureToastEl() {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  return toast;
}

/** 自定义顶部提示（替代 alert） */
function showToast(msg, ms = 2600, type = '') {
  const toast = ensureToastEl();
  toast.textContent = String(msg || '');
  toast.classList.remove('toast-error', 'toast-ok');
  if (type === 'error') toast.classList.add('toast-error');
  if (type === 'ok') toast.classList.add('toast-ok');
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove('show', 'toast-error', 'toast-ok');
  }, ms);
}

/** 自定义确认框（替代 confirm），返回 Promise<boolean> */
function showConfirm(message, { confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let overlay = document.getElementById('app-confirm');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'app-confirm';
      overlay.className = 'app-confirm';
      overlay.innerHTML = `
        <div class="app-confirm-card" role="dialog" aria-modal="true">
          <p class="app-confirm-msg"></p>
          <div class="app-confirm-actions">
            <button type="button" class="btn btn-tiny app-confirm-cancel"></button>
            <button type="button" class="btn btn-primary app-confirm-ok"></button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
    const msgEl = overlay.querySelector('.app-confirm-msg');
    const okBtn = overlay.querySelector('.app-confirm-ok');
    const cancelBtn = overlay.querySelector('.app-confirm-cancel');
    msgEl.textContent = String(message || '');
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = 'btn app-confirm-ok ' + (danger ? 'btn-danger' : 'btn-primary');
    const finish = (val) => {
      overlay.classList.remove('show');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      overlay.onclick = null;
      resolve(val);
    };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    overlay.onclick = (e) => { if (e.target === overlay) finish(false); };
    overlay.classList.add('show');
  });
}

function getInviteUrl(roomId) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', roomId);
  return url.toString();
}

function clearInviteFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('room') || url.searchParams.has('code')) {
      url.searchParams.delete('room');
      url.searchParams.delete('code');
      history.replaceState({}, '', url.pathname + url.hash);
    }
  } catch (_) {}
}

// -------------------------
// CARD DISPLAY HELPERS
// -------------------------
function displayRank(r) {
  return r === 'T' ? '10' : r;
}
const SUIT_SYMBOLS = { 's': '♠', 'h': '♥', 'd': '♦', 'c': '♣' };
const RED_SUITS = { 'h': true, 'd': true };

// -------------------------
// AUDIO MANAGER
// -------------------------
function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playSound(type) {
  if (!soundEnabled) return;
  initAudio();
  const ctx = audioCtx;
  const now = ctx.currentTime;
  const createOsc = (freq, dur, type='sine', vol=0.1) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  };
  switch(type) {
    case 'click': createOsc(800, 0.05, 'square', 0.05); break;
    case 'deal': createOsc(400, 0.1, 'sine', 0.05); break;
    case 'fold': createOsc(200, 0.15, 'sawtooth', 0.05); break;
    case 'win':
      [523, 659, 784].forEach((f, i) => setTimeout(() => createOsc(f, 0.2, 'sine', 0.1), i * 100));
      break;
    case 'tick': createOsc(1000, 0.03, 'square', 0.03); break;
    case 'turn': createOsc(600, 0.1, 'sine', 0.08); setTimeout(() => createOsc(800, 0.1, 'sine', 0.08), 100); break;
    case 'notification':
      [440, 554, 659].forEach((f, i) => setTimeout(() => createOsc(f, 0.15, 'sine', 0.12), i * 80));
      break;
  }
}

function amIHost() {
  if (!currentRoom) return false;
  return !!currentRoom.players.find(p => p.id === mySocketId)?.isHost;
}

// -------------------------
// NOTIFICATION BADGE
// -------------------------
function updateNotificationBadge() {
  if (!currentRoom) return;
  const badges = [
    document.getElementById('settings-badge'),
    document.getElementById('menu-badge')
  ].filter(Boolean);
  const isHost = amIHost();
  if (!isHost) {
    badges.forEach(b => b.classList.remove('show'));
    return;
  }
  const rebuyCount = (currentRoom.rebuyRequests || []).length;
  const joinCount = (currentRoom.joinRequests || []).filter(r => !r.approved).length;
  const totalCount = rebuyCount + joinCount;
  if (totalCount > lastRequestCount && totalCount > 0) {
    playSound('notification');
  }
  lastRequestCount = totalCount;
  badges.forEach(badge => {
    if (totalCount > 0) {
      badge.classList.add('show');
      badge.innerText = totalCount;
    } else {
      badge.classList.remove('show');
    }
  });
}

// -------------------------
// SCREEN MANAGEMENT
// -------------------------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.getElementById('sidebar')?.classList.remove('open');
  fillNicknameInputs();
}

// -------------------------
// LOBBY LOGIC
// -------------------------
function createRoom() {
  const maxPlayersRaw = parseInt(document.getElementById('host-max').value);
  if (!maxPlayersRaw || maxPlayersRaw < 2) return showToast('人数至少 2 人', 2800, 'error');
  if (maxPlayersRaw > 12) return showToast('最多 12 人', 2800, 'error');
  if (!socket.connected) return showToast('未连接，请先登录', 2800, 'error');

  const bigBlind = Math.max(1, parseInt(document.getElementById('host-bb').value) || 2);
  const startingChips = parseInt(document.getElementById('host-chips').value) || bigBlind * 100;
  socket.emit('create-room', {
    roomName: document.getElementById('host-roomname').value.trim(),
    password: document.getElementById('host-password').value,
    smallBlind: parseInt(document.getElementById('host-sb').value),
    bigBlind,
    maxPlayers: maxPlayersRaw,
    startingChips,
    rebuysAllowed: document.getElementById('host-rebuys').checked,
    rebuyNeedsApproval: document.getElementById('host-rebuy-approval').checked,
    timerEnabled: document.getElementById('host-timer').checked,
    timerSeconds: parseInt(document.getElementById('host-timer-duration').value) || 20,
    sessionMinutes: parseInt(document.getElementById('host-session-minutes').value)
  });
}

function formatSessionHours(minutes) {
  const m = Number(minutes) || 0;
  const h = m / 60;
  if (Number.isInteger(h)) return `${h} 小时`;
  return `${h.toFixed(1)} 小时`;
}

function bindSessionSlider() {
  const slider = document.getElementById('host-session-minutes');
  const label = document.getElementById('host-session-label');
  if (!slider || !label) return;
  const sync = () => { label.textContent = formatSessionHours(slider.value); };
  slider.addEventListener('input', sync);
  sync();
}
bindSessionSlider();

function openJoinModal(code) {
  document.getElementById('join-modal-code').value = code || '';
  document.getElementById('join-modal-nickname').value = getSavedNickname();
  document.getElementById('join-modal-password').value = '';
  document.getElementById('join-modal').classList.add('show');
  setTimeout(() => {
    if (code) document.getElementById('join-modal-nickname').focus();
    else document.getElementById('join-modal-code').focus();
  }, 100);
}

function closeJoinModal() {
  document.getElementById('join-modal').classList.remove('show');
}

function joinRoomFromModal() {
  const code = document.getElementById('join-modal-code').value.trim().toUpperCase();
  const password = document.getElementById('join-modal-password').value;
  if (!code) return showToast('请输入房间号', 2800, 'error');
  if (!socket.connected) return showToast('未连接，请先登录', 2800, 'error');
  socket.emit('join-room', { roomCode: code, password });
  closeJoinModal();
}

function spectateFromModal() {
  const code = document.getElementById('join-modal-code').value.trim().toUpperCase();
  const password = document.getElementById('join-modal-password').value;
  if (!code) return showToast('请输入房间号', 2800, 'error');
  if (!socket.connected) return showToast('未连接，请先登录', 2800, 'error');
  socket.emit('spectate-room', { roomCode: code, password });
  closeJoinModal();
}

function joinRoomDirect() {
  const code = (document.getElementById('join-code')?.value || '').trim().toUpperCase();
  const password = document.getElementById('join-password')?.value || '';
  if (!code) return showToast('请输入房间号', 2800, 'error');
  if (!socket.connected) return showToast('未连接，请先登录', 2800, 'error');
  socket.emit('join-room', { roomCode: code, password });
}

function spectateDirect() {
  const code = (document.getElementById('join-code')?.value || '').trim().toUpperCase();
  const password = document.getElementById('join-password')?.value || '';
  if (!code) return showToast('请输入房间号', 2800, 'error');
  if (!socket.connected) return showToast('未连接，请先登录', 2800, 'error');
  socket.emit('spectate-room', { roomCode: code, password });
}

function joinRoomByCode(code, password = '') {
  if (!socket.connected) return showToast('未连接，请先登录', 2800, 'error');
  socket.emit('join-room', { roomCode: String(code || '').toUpperCase(), password });
}

function spectateRoomByCode(code, password = '') {
  if (!socket.connected) return showToast('未连接，请先登录', 2800, 'error');
  socket.emit('spectate-room', { roomCode: String(code || '').toUpperCase(), password });
}

socket.on('public-rooms', (rooms) => {
  const list = document.getElementById('public-rooms-list');
  list.innerHTML = '';
  if (!rooms || rooms.length === 0) {
    list.innerHTML = '<p class="no-rooms">No rooms available.<br>Create one!</p>';
    return;
  }
  rooms.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-item';
    const lockIcon = r.hasPassword ? ' [Private]' : '';
    const statusText = r.isPlaying ? ' (In Progress)' : '';
    const fullText = r.playerCount >= r.maxPlayers ? ' (Full)' : '';
    div.innerHTML = `
      <div class="room-info-item">
        <b>${r.name}${lockIcon}</b><br>
        <small>${r.playerCount}/${r.maxPlayers} players${statusText}${fullText}</small>
      </div>
      <button class="btn btn-tiny btn-primary">Join</button>
    `;
    const openModal = (e) => {
      e.stopPropagation();
      openJoinModal(r.id);
    };
    div.querySelector('button').addEventListener('click', openModal);
    div.addEventListener('click', openModal);
    list.appendChild(div);
  });
});

// -------------------------
// ROOM EVENTS
// -------------------------
socket.on('joined-room', (state) => {
  currentRoom = state;
  mySocketId = socket.id;
  clearInviteFromUrl();
  if (window.App) window.App.showGame();
  else showScreen('screen-game');
  renderTable();
  document.getElementById('room-code-display').innerText = `房间 ${state.id}`;
  document.getElementById('host-display').innerText = `| 房主: ${state.players.find(p => p.isHost)?.name || '—'}`;
  updateHostUI();
  updateSpectatorUI();
  startSessionClockUI(state.sessionEndsAt);
  showToast('已进入房间，点「邀请」分享给好友');
});

socket.on('left-room', () => {
  currentRoom = null;
  isSpectator = false;
});

socket.on('set-spectator', (val) => {
  isSpectator = val;
  updateSpectatorUI();
});

socket.on('auto-sit-out', (data) => {
  showToast(data?.message || '已自动暂离（留位）', 3200);
  updateSitOutButton();
});

socket.on('sit-out-pending', (data) => {
  showToast(data?.message || '本手结束后将暂离', 2800);
  if (currentRoom) {
    const me = currentRoom.players?.find(p => p.id === mySocketId);
    if (me) me.wantSitOut = true;
  }
  updateSitOutButton();
});

socket.on('leave-seat-pending', (data) => {
  showToast(data?.message || '本手结束后将离开座位', 2800);
});

socket.on('forced-leave-seat', (data) => {
  isSpectator = true;
  showToast(data?.message || '已离开座位', 4000);
  updateSpectatorUI();
});

socket.on('joined-as-player', () => {
  isSpectator = false;
  hasRequestedJoin = false;
  updateSpectatorUI();
});

socket.on('join-pending-next-hand', (data) => {
  showToast(data?.message || '已入座，下一手自动入局', 3600);
});

socket.on('join-requested', (val) => {
  hasRequestedJoin = val;
  updateSpectatorUI();
});

socket.on('join-status', (data) => {
  if (data.status === 'approved') {
    showToast('入座申请已通过，下一手开始时入座。', 3200);
  } else if (data.status === 'declined') {
    showToast('入座申请被拒绝。', 3200);
    hasRequestedJoin = false;
    updateSpectatorUI();
  }
});

socket.on('rebuy-pending', (val) => {
  rebuyPending = val;
  updateSpectatorUI();
});

socket.on('rebuy-result', (data) => {
  rebuyPending = false;
  if (data.approved) {
    showToast(`买入已批准 $${data.amount}，下一手入局。`, 3200);
  } else {
    showToast('买入申请被拒绝。', 3200);
  }
  updateSpectatorUI();
});

socket.on('game-ended', () => {
  leaveRoom();
});

socket.on('session-ending', (data) => {
  showToast(data?.message || '牌局即将结算…', 3200);
  const clock = document.getElementById('session-clock');
  if (clock) {
    clock.textContent = '即将结算';
    clock.classList.add('urgent');
  }
});

socket.on('session-settled', (payload) => {
  currentRoom = null;
  isSpectator = false;
  if (nextHandInterval) { clearInterval(nextHandInterval); nextHandInterval = null; }
  if (sessionClockTimer) { clearInterval(sessionClockTimer); sessionClockTimer = null; }
  if (window.App) window.App.showSettlement(payload);
  else {
    showToast('牌局已结算', 3200);
    if (window.App) window.App.showLobby();
  }
});

socket.on('error-msg', (msg) => showToast(msg, 3200, 'error'));

socket.on('state-update', (state) => {
  currentRoom = state;
  renderTable();
  if (state.sessionEndsAt) startSessionClockUI(state.sessionEndsAt);
  // Update host display in top bar (in case host changed due to disconnect)
  const hostPlayer = state.players.find(p => p.isHost);
  document.getElementById('host-display').innerText = `| 房主: ${hostPlayer?.name || '—'}`;
  // 人手不足卡住时才显示下一手遮罩
  if (state.gameState.status === 'waiting') {
    /* start overlay handled in renderTable */
  }
  if (document.getElementById('settings-modal').classList.contains('show')) {
    updateSettingsUI();
  }
  updateHostUI();
  updateSpectatorUI();
});

socket.on('hand-started', (state) => {
  currentRoom = state;
  renderTable();
  playSound('deal');
  document.getElementById('next-hand-overlay').classList.add('hidden');
  nextHandStartAt = 0;
  if (nextHandInterval) { clearInterval(nextHandInterval); nextHandInterval = null; }
});

socket.on('hand-ended', (data) => {
  currentRoom = data.state;
  if (typeof data.handHistoryCount === 'number') {
    handHistoryTotal = data.handHistoryCount;
    if (currentRoom) currentRoom.handHistoryCount = data.handHistoryCount;
  }
  renderTable();
  const results = Array.isArray(data.results) ? data.results : [];
  const iWon = results.some(r => r.playerId === mySocketId);
  if (iWon) playSound('win');
  else playSound('fold');
  showHandWinBanner(results);
  // 下一手立即开始，不展示倒计时遮罩
  document.getElementById('next-hand-overlay')?.classList.add('hidden');
  // 若历史弹窗开着，刷新到最新一手
  if (document.getElementById('hand-history-modal')?.classList.contains('show')) {
    requestHandHistory('latest');
  }
});

/** 一手结束赢牌提示：自己 →「你赢了 $x」；他人 →「名字赢了 $x」 */
function showHandWinBanner(results) {
  const banner = document.getElementById('win-banner');
  if (!banner) return;
  if (!results.length) {
    banner.classList.remove('show', 'win-banner-me');
    banner.innerHTML = '';
    return;
  }

  // 同一玩家可能拿主池+边池，合并金额
  const skipHandLabel = (h) => !h || h === 'Win by Fold' || h === 'Uncontested Side Pot';
  const totals = new Map();
  for (const r of results) {
    const prev = totals.get(r.playerId) || { amount: 0, name: r.playerName || '', hand: r.hand };
    prev.amount += r.amount || 0;
    if (r.playerName) prev.name = r.playerName;
    // 有真实牌型时覆盖「无人跟注」这类占位文案
    if (r.hand && !skipHandLabel(r.hand)) prev.hand = r.hand;
    else if (!prev.hand) prev.hand = r.hand;
    totals.set(r.playerId, prev);
  }

  const parts = [];
  for (const [pid, info] of totals) {
    const p = currentRoom?.players?.find(pl => pl.id === pid);
    const isMe = pid === mySocketId;
    const who = isMe ? '你' : (info.name || p?.name || '玩家');
    // 弃牌收池不展示牌型；摊牌才显示成牌名
    const handZh = skipHandLabel(info.hand) ? '' : (HAND_NAME_ZH[info.hand] || info.hand || '');
    const handPart = handZh
      ? `<span class="win-banner-hand">（${escapeHtml(handZh)}）</span>`
      : '';
    parts.push(
      `<span class="win-banner-line${isMe ? ' is-me' : ''}">` +
      `<span class="win-banner-who">${escapeHtml(who)}</span>赢了 ` +
      `<span class="win-banner-amt">$${info.amount}</span>${handPart}` +
      `</span>`
    );
  }

  banner.innerHTML = parts.join('<span class="win-banner-sep"> · </span>');
  banner.classList.toggle('win-banner-me', totals.has(mySocketId));
  banner.classList.add('show');
  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => {
    banner.classList.remove('show', 'win-banner-me');
    banner.innerHTML = '';
  }, 5200);
}

socket.on('hand-history-page', (data) => {
  handHistoryTotal = data?.total || 0;
  handHistoryIndex = data?.index ?? -1;
  handHistoryCache = data?.hand || null;
  renderHandHistoryPage();
});

socket.on('turn-timer', (data) => {
  if (data.playerId === mySocketId && data.endTime > 0) playSound('turn');
  startTimerCountdown(data.endTime, data.playerId === mySocketId);
});

socket.on('chat-message', (msg) => {
  const div = document.getElementById('chat-messages');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'chat-msg' + (msg.isSpectator ? ' spectator' : '');
  msgDiv.innerHTML = `<b>${escapeHtml(msg.sender)}:</b> ${escapeHtml(msg.message)}`;
  div.appendChild(msgDiv);
  div.scrollTop = div.scrollHeight;
  const chatOpen = document.getElementById('chat-container')?.classList.contains('active');
  const myName = currentRoom?.players?.find(p => p.id === mySocketId)?.name;
  if (!chatOpen && msg.sender !== myName) bumpChatBadge();
  if (typeof msg.seatIndex === 'number') {
    showSeatBubble(msg.seatIndex, msg.message, { kind: 'text' });
  }
});

function bumpChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (!badge) return;
  const n = (parseInt(badge.innerText, 10) || 0) + 1;
  badge.innerText = String(n);
  badge.classList.add('show');
}

function clearChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (!badge) return;
  badge.innerText = '0';
  badge.classList.remove('show');
}

socket.on('emoji-received', (data) => {
  if (typeof data?.seatIndex !== 'number' || !data.emoji) return;
  showSeatBubble(data.seatIndex, data.emoji, { kind: 'emoji' });
  const div = document.getElementById('chat-messages');
  if (div && data.sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg chat-msg-emoji';
    msgDiv.innerHTML = `<b>${escapeHtml(data.sender)}:</b> <span class="chat-emoji-inline">${escapeHtml(data.emoji)}</span>`;
    div.appendChild(msgDiv);
    div.scrollTop = div.scrollHeight;
  }
});

socket.on('kicked', (data) => {
  if (data && data.toSpectator) {
    showToast(data?.afterHand ? '本手结束后你将移至观战' : '房主已将你移至观战。', 3200);
    isSpectator = true;
    hasRequestedJoin = false;
    rebuyPending = false;
    updateSpectatorUI();
  } else {
    showToast('你已被房主移出房间。', 3200);
    leaveRoom();
  }
});

// -------------------------
// TIMER COUNTDOWN
// -------------------------
function applyTimerProgress(pct, urgent) {
  const heroFill = document.getElementById('hero-timer-fill');
  if (heroFill) {
    heroFill.style.width = `${pct}%`;
    heroFill.classList.toggle('urgent', urgent);
  }
  // 当前行动座位名牌底部进度条（别人读秒也能看见）
  document.querySelectorAll('#seats-container .seat .seat-timer-fill').forEach(el => {
    el.style.width = '0%';
    el.classList.remove('urgent');
  });
  const seatFill = document.querySelector('#seats-container .seat.active .seat-timer-fill');
  if (seatFill) {
    seatFill.style.width = `${pct}%`;
    seatFill.classList.toggle('urgent', urgent);
  }
  const ringFg = document.getElementById('timer-ring-fg');
  if (ringFg) ringFg.style.strokeDashoffset = String(100 - pct);
}

function startTimerCountdown(endTime, isMyTurn = false) {
  const extendBtn = document.getElementById('btn-extend-timer');
  const heroBar = document.getElementById('hero-timer-bar');
  if (!endTime || endTime === 0) {
    activeTimerEnd = 0;
    activeTimerInitialLeft = 0;
    extendBtn?.classList.remove('show', 'urgent');
    heroBar?.setAttribute('hidden', '');
    applyTimerProgress(0, false);
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    return;
  }
  activeTimerEnd = endTime;
  if (extendBtn) extendBtn.classList.toggle('show', !!isMyTurn);
  if (isMyTurn) heroBar?.removeAttribute('hidden');
  else heroBar?.setAttribute('hidden', '');
  if (timerInterval) clearInterval(timerInterval);
  const initialLeft = Math.max(0.1, (endTime - Date.now()) / 1000);
  activeTimerInitialLeft = initialLeft;
  const update = () => {
    const timeLeft = Math.max(0, (endTime - Date.now()) / 1000);
    const pct = Math.max(0, Math.min(100, (timeLeft / initialLeft) * 100));
    const urgent = timeLeft < 5;
    applyTimerProgress(pct, urgent);
    extendBtn?.classList.toggle('urgent', urgent);
    if (urgent) {
      const wholeSec = Math.ceil(timeLeft);
      if (timeLeft > 0 && wholeSec !== update._lastTick) {
        update._lastTick = wholeSec;
        if (isMyTurn) playSound('tick');
      }
    }
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      activeTimerEnd = 0;
      extendBtn?.classList.remove('show', 'urgent');
      heroBar?.setAttribute('hidden', '');
      applyTimerProgress(0, false);
    }
  };
  update();
  timerInterval = setInterval(update, 100);
}

function extendTurnTimer() {
  if (!socket.connected) return;
  socket.emit('extend-timer');
}

// -------------------------
// NEXT HAND OVERLAY
// -------------------------
let nextHandStartAt = 0;

function hideNextHandOverlay() {
  document.getElementById('next-hand-overlay')?.classList.add('hidden');
  nextHandStartAt = 0;
  if (nextHandInterval) {
    clearInterval(nextHandInterval);
    nextHandInterval = null;
  }
}

/** 已改为后台自动开下一手，不再弹出遮罩挡住公共牌 */
function showNextHandOverlay() {
  hideNextHandOverlay();
}

socket.on('next-hand-scheduled', () => {
  hideNextHandOverlay();
});

socket.on('next-hand-cancelled', () => {
  hideNextHandOverlay();
});

// -------------------------
// HOST UI HELPERS
// -------------------------
function updateHostUI() {
  if (!currentRoom) return;
  const isHost = amIHost();
  const hostBtn = document.getElementById('host-settings-btn');
  if (hostBtn) hostBtn.style.display = isHost ? 'flex' : 'none';
  const rebuysStatus = document.getElementById('rebuys-status');
  if (rebuysStatus) {
    rebuysStatus.innerText = currentRoom.settings.rebuysAllowed ? '允许' : '关闭';
  }
  const approvalStatus = document.getElementById('rebuy-approval-status');
  if (approvalStatus) {
    approvalStatus.innerText = currentRoom.settings.rebuyNeedsApproval ? '需审核' : '免审';
  }
  updateNotificationBadge();
}

// -------------------------
// SPECTATOR UI
// -------------------------
function updateSpectatorUI() {
  const area = document.getElementById('spectator-join-area');
  const btnJoin = document.getElementById('btn-request-join');
  const btnCancel = document.getElementById('btn-cancel-join');
  const rebuyArea = document.getElementById('rebuy-area');
  const rebuyPendingArea = document.getElementById('rebuy-pending-area');
  const rebuyBtn = rebuyArea.querySelector('button');
  const chatInputRow = document.getElementById('chat-input-row');
  const chatNotice = document.getElementById('chat-spectator-notice');
  updateSitOutButton();

  if (isSpectator) {
    area.style.display = 'block';
    rebuyArea.style.display = 'none';
    rebuyPendingArea.style.display = 'none';
    // Hide chat input + emoji — spectators can't chat or react
    if (chatInputRow) chatInputRow.style.display = 'none';
    if (chatNotice) chatNotice.style.display = 'block';
    if (hasRequestedJoin) {
      btnJoin.style.display = 'none';
      btnCancel.style.display = 'block';
    } else {
      btnJoin.style.display = 'block';
      btnCancel.style.display = 'none';
    }
  } else {
    area.style.display = 'none';
    // Show chat input + emoji for players
    if (chatInputRow) chatInputRow.style.display = 'flex';
    if (chatNotice) chatNotice.style.display = 'none';
    const me = currentRoom?.players.find(p => p.id === mySocketId);
    const isHost = amIHost();
    if (me && currentRoom.settings.rebuysAllowed && !rebuyPending) {
      rebuyArea.style.display = 'block';
      rebuyPendingArea.style.display = 'none';
      if (rebuyBtn) {
        const freeRebuy = isHost || !currentRoom.settings.rebuyNeedsApproval;
        rebuyBtn.innerText = freeRebuy ? '立即买入' : '申请买入';
      }
    } else if (me && rebuyPending) {
      rebuyArea.style.display = 'none';
      rebuyPendingArea.style.display = 'block';
    } else {
      rebuyArea.style.display = 'none';
      rebuyPendingArea.style.display = 'none';
    }
  }
}

function requestJoin() {
  socket.emit('request-join');
}

function cancelJoin() {
  socket.emit('cancel-join');
}

// REBUY flow
function openRebuyModal() {
  const isHost = amIHost();
  const defaultAmount = currentRoom?.settings?.startingChips || 1000;
  document.getElementById('rebuy-modal-amount').value = defaultAmount;
  const desc = document.getElementById('rebuy-modal-desc');
  const submitBtn = document.getElementById('rebuy-modal-submit');
  const needsApproval = !!currentRoom?.settings?.rebuyNeedsApproval && !isHost;
  if (isHost || !needsApproval) {
    desc.innerText = '填写买入金额，确认后立即加入桌面筹码。';
    submitBtn.innerText = '立即买入';
  } else {
    desc.innerText = '填写买入金额，需房主批准后到账。';
    submitBtn.innerText = '提交申请';
  }
  document.getElementById('rebuy-modal').classList.add('show');
  setTimeout(() => document.getElementById('rebuy-modal-amount').focus(), 100);
}

function closeRebuyModal() {
  document.getElementById('rebuy-modal').classList.remove('show');
}

function sendRebuyRequest() {
  const amount = parseInt(document.getElementById('rebuy-modal-amount').value);
  if (!amount || amount < 1) return showToast('请输入有效金额', 2800, 'error');
  // host-rebuy 与 rebuy-request（含免审）服务端均支持立即到账
  if (amIHost()) socket.emit('host-rebuy', { amount });
  else socket.emit('rebuy-request', { amount });
  closeRebuyModal();
}

function toggleRebuyApproval() {
  socket.emit('host-action', { type: 'toggle-rebuy-approval' });
}

function cancelRebuyRequest() {
  socket.emit('cancel-rebuy');
}

// HOST actions for rebuy/join requests
function approveRebuy(playerId, amount) {
  const numAmount = parseInt(amount);
  if (!numAmount || numAmount < 1) return showToast('请输入有效金额', 2800, 'error');
  socket.emit('approve-rebuy', { playerId, amount: numAmount });
}

function declineRebuy(playerId) {
  socket.emit('decline-rebuy', { playerId });
}

function acceptJoin(spectatorId) {
  socket.emit('accept-join', { spectatorId });
}

function declineJoin(spectatorId) {
  socket.emit('decline-join', { spectatorId });
}

async function endGame() {
  const ok = await showConfirm('确定解散房间？所有人将返回大厅。', { danger: true, confirmText: '解散' });
  if (!ok) return;
  socket.emit('end-game');
  setTimeout(() => leaveRoom(), 200);
}

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('open');
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
}

function openRebuyFromMenu() {
  if (!currentRoom) return;
  if (isSpectator) {
    showToast('观战中无法买入，请先入座', 3200);
    return;
  }
  if (!currentRoom.settings?.rebuysAllowed) {
    showToast('本桌已关闭买入', 3200);
    return;
  }
  if (rebuyPending) {
    showToast('已有买入申请等待确认', 3200);
    return;
  }
  openRebuyModal();
}

// -------------------------
// SIDEBAR RENDERING
// -------------------------
function renderSidebar() {
  if (!currentRoom) return;
  const playersDiv = document.getElementById('sidebar-players');
  const spectatorsDiv = document.getElementById('sidebar-spectators');
  const players = [...currentRoom.players].sort((a,b) => a.seatIndex - b.seatIndex);
  const positionMap = computePositionMap(currentRoom);
  playersDiv.innerHTML = players.map(p => {
    const isMe = p.id === mySocketId;
    let status = '';
    if (p.hasRebought) status = '(下局买入)';
    else if (p.folded) status = '(弃牌)';
    else if (p.allIn) status = '(全下)';
    else if (p.pendingJoin) status = '(下下手入局)';
    else if (p.isSittingOut) status = '(暂离)';
    const pos = positionMap[p.seatIndex];
    const posTag = pos ? `<span class="sp-pos">${escapeHtml(pos.name)}</span>` : '';
    return `<div class="sidebar-player ${isMe ? 'me' : ''} ${p.folded ? 'folded' : ''}">
      <span class="sp-name">${posTag}${escapeHtml(p.name)} ${escapeHtml(status)}</span>
      <span class="sp-chips">$${p.chips}</span>
    </div>`;
  }).join('');
  const specs = currentRoom.spectators || [];
  if (specs.length === 0) {
    spectatorsDiv.innerHTML = '<div class="sidebar-spectator"><span class="sp-name" style="opacity:0.5;">暂无</span></div>';
  } else {
    spectatorsDiv.innerHTML = specs.map(s => {
      const isMe = s.id === mySocketId;
      let tag = '';
      if (s.wantsJoin && !s.joinApproved) tag = '<span class="join-tag">申请中</span>';
      else if (s.joinApproved) tag = '<span class="join-tag" style="color:var(--btn-secondary);">已通过</span>';
      return `<div class="sidebar-spectator ${s.wantsJoin ? 'wants-join' : ''}">
        <span class="sp-name">${escapeHtml(s.name)}${isMe ? ' (我)' : ''}</span>
        ${tag}
      </div>`;
    }).join('');
  }
}

// -------------------------
// TABLE RENDERING
// -------------------------
function avatarColor(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360}, 48%, 40%)`;
}

function avatarInitials(name) {
  const s = String(name || '?').trim();
  return s.slice(0, 2).toUpperCase() || '?';
}

function cardHtml(c, extraClass = '') {
  if (!c) return `<div class="card card-back ${extraClass}"></div>`;
  const isRed = RED_SUITS[c.s];
  const suit = SUIT_SYMBOLS[c.s] || '';
  return `<div class="card ${isRed ? 'red' : ''} ${extraClass}"><div class="card-rank">${displayRank(c.r)}</div><div class="card-suit-center" aria-hidden="true">${suit}</div></div>`;
}

function cardLabel(c) {
  if (!c) return '';
  return `${displayRank(c.r)}${SUIT_SYMBOLS[c.s] || ''}`;
}

/** 摊牌阶段：弃牌者请求秀牌 */
function requestShowCards(which) {
  if (!socket?.connected) return;
  if (which === 'all') socket.emit('show-cards', { all: true });
  else socket.emit('show-cards', { index: which });
  playSound('click');
}

function updateShowCardsBar(me) {
  const bar = document.getElementById('show-cards-bar');
  if (!bar) return;
  const isShowdown = currentRoom?.gameState?.status === 'playing'
    && currentRoom.gameState.bettingRound === 'showdown';
  const mask = me?.shownHoleMask || [false, false];
  const cards = me?.holeCards || [];
  // 仅弃牌且还有未秀出的牌时显示；池内玩家已自动秀完
  const canOptShow = !!(isShowdown && me && !isSpectator && me.folded
    && cards.length >= 2 && !(mask[0] && mask[1]));
  bar.hidden = !canOptShow;
  document.getElementById('action-bar')?.classList.toggle('show-cards-open', canOptShow);
  if (!canOptShow) return;

  const btn0 = document.getElementById('show-card-btn-0');
  const btn1 = document.getElementById('show-card-btn-1');
  if (btn0) {
    btn0.textContent = cardLabel(cards[0]) || '—';
    btn0.disabled = !!mask[0];
    btn0.classList.toggle('is-shown', !!mask[0]);
    btn0.classList.toggle('red', !!(cards[0] && RED_SUITS[cards[0].s]));
  }
  if (btn1) {
    btn1.textContent = cardLabel(cards[1]) || '—';
    btn1.disabled = !!mask[1];
    btn1.classList.toggle('is-shown', !!mask[1]);
    btn1.classList.toggle('red', !!(cards[1] && RED_SUITS[cards[1].s]));
  }
}

// -------------------------
// 牌型展示（与服务端逻辑一致，中文名）
// -------------------------
const HAND_NAME_ZH = {
  'Royal Flush': '皇家同花顺',
  'Straight Flush': '同花顺',
  'Four of a Kind': '四条',
  'Full House': '葫芦',
  'Flush': '同花',
  'Straight': '顺子',
  'Three of a Kind': '三条',
  'Two Pair': '两对',
  'One Pair': '一对',
  'High Card': '高牌'
};

const STREET_ZH = { preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' };
const ACTION_ZH = {
  sb: '小盲', bb: '大盲', fold: '弃牌', check: '过牌', call: '跟注',
  raise: '加注', allin: '全下'
};

let handHistoryIndex = -1;
let handHistoryTotal = 0;
let handHistoryCache = null;

function rankValueClient(r) {
  return { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, 'T':10, 'J':11, 'Q':12, 'K':13, 'A':14 }[r];
}

function evaluate5Client(cards) {
  const ranks = cards.map(c => rankValueClient(c.r)).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);
  let isStraight = true;
  for (let i = 0; i < 4; i++) {
    if (ranks[i] - 1 !== ranks[i + 1]) { isStraight = false; break; }
  }
  if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
    isStraight = true;
    ranks.push(ranks.shift());
  }
  const counts = {};
  ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  const groups = Object.entries(counts).map(([r, c]) => [parseInt(r), c]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (isFlush && isStraight) return { rank: 8, values: ranks, name: ranks[0] === 14 ? 'Royal Flush' : 'Straight Flush' };
  if (groups[0][1] === 4) return { rank: 7, values: [groups[0][0], groups[1][0]], name: 'Four of a Kind' };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { rank: 6, values: [groups[0][0], groups[1][0]], name: 'Full House' };
  if (isFlush) return { rank: 5, values: ranks, name: 'Flush' };
  if (isStraight) return { rank: 4, values: ranks, name: 'Straight' };
  if (groups[0][1] === 3) return { rank: 3, values: [groups[0][0], groups[1][0], groups[2][0]], name: 'Three of a Kind' };
  if (groups[0][1] === 2 && groups[1][1] === 2) return { rank: 2, values: [groups[0][0], groups[1][0], groups[2][0]], name: 'Two Pair' };
  if (groups[0][1] === 2) return { rank: 1, values: [groups[0][0], groups[1][0], groups[2][0], groups[3][0]], name: 'One Pair' };
  return { rank: 0, values: ranks, name: 'High Card' };
}

function compareHandsClient(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < a.values.length; i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0;
}

function bestHandClient(cards) {
  let best = null;
  const n = cards.length;
  if (n < 5) return null;
  for (let i = 0; i < n - 4; i++)
    for (let j = i + 1; j < n - 3; j++)
      for (let k = j + 1; k < n - 2; k++)
        for (let l = k + 1; l < n - 1; l++)
          for (let m = l + 1; m < n; m++) {
            const hand = evaluate5Client([cards[i], cards[j], cards[k], cards[l], cards[m]]);
            if (!best || compareHandsClient(hand, best) > 0) best = hand;
          }
  return best;
}

function describeHeroHand(holeCards, communityCards) {
  if (!holeCards || holeCards.length < 2) return null;
  const board = communityCards || [];
  const all = [...holeCards, ...board];
  if (all.length >= 5) {
    const best = bestHandClient(all);
    if (!best) return null;
    return { name: HAND_NAME_ZH[best.name] || best.name, rank: best.rank };
  }
  // 翻前 / 牌不足 5 张：只看底牌
  if (holeCards[0].r === holeCards[1].r) {
    return { name: '一对', rank: 1 };
  }
  return { name: '高牌', rank: 0 };
}

function updateHeroHandRank(me) {
  const el = document.getElementById('hero-hand-rank');
  if (!el) return;
  if (!me || !me.holeCards || me.holeCards.length < 2 || isSpectator || me.folded) {
    el.textContent = '';
    el.className = 'hero-hand-rank';
    return;
  }
  if (currentRoom?.gameState?.status !== 'playing') {
    el.textContent = '';
    el.className = 'hero-hand-rank';
    return;
  }
  const info = describeHeroHand(me.holeCards, currentRoom.gameState.communityCards || []);
  if (!info) {
    el.textContent = '';
    el.className = 'hero-hand-rank';
    return;
  }
  el.textContent = info.name;
  el.className = 'hero-hand-rank';
  if (info.rank >= 7) el.classList.add('rank-monster');
  else if (info.rank >= 4) el.classList.add('rank-strong');
}

function formatChips(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return String(v);
}

function getTotalPot() {
  return (currentRoom?.gameState?.pots || []).reduce((s, p) => s + p.amount, 0);
}

function getMinRaiseTotal() {
  return (currentRoom?.gameState?.currentBet || 0) + (currentRoom?.gameState?.minRaise || 0);
}

/** 计算底池比例对应的「总下注额」（桌上已有注 + 本次要推入的筹码） */
function calcPotBetTotal(frac) {
  if (!currentRoom) return 0;
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me) return 0;
  const pot = getTotalPot() || currentRoom.settings.bigBlind * 2;
  const toCall = Math.max(0, (currentRoom.gameState.currentBet || 0) - (me.currentBet || 0));
  // 先跟平再按有效底池比例加注：跟注后底池 = pot + toCall
  const potAfterCall = pot + toCall;
  const raiseSize = Math.max(0, Math.round(potAfterCall * frac));
  const target = (me.currentBet || 0) + toCall + raiseSize;
  const minRaise = getMinRaiseTotal();
  const maxRaise = (me.currentBet || 0) + me.chips;
  return Math.min(Math.max(target, minRaise), maxRaise);
}

function setRaiseAmount(total) {
  if (!currentRoom) return;
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me) return;
  const minRaise = getMinRaiseTotal();
  const maxRaise = (me.currentBet || 0) + me.chips;
  const clamped = Math.min(Math.max(total, minRaise), maxRaise);
  const amountEl = document.getElementById('raise-amount');
  if (amountEl) amountEl.value = String(clamped);
  syncRaiseSlider();
  updateRaiseBetDisplay();
}

function setRaisePreset(frac) {
  setRaiseAmount(calcPotBetTotal(frac));
}

function applyBetPreset(frac, btn) {
  setRaisePreset(frac);
  highlightPresetBtn(btn);
  playSound('click');
}

function applyMinRaise(btn) {
  setRaiseMin();
  highlightPresetBtn(btn);
  playSound('click');
}

function applyBetAllIn(btn) {
  setRaiseAllIn();
  highlightPresetBtn(btn);
  playSound('click');
}

function highlightPresetBtn(btn) {
  document.querySelectorAll('#bet-presets .preset-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function setRaiseMin() {
  setRaiseAmount(getMinRaiseTotal());
}

function setRaiseAllIn() {
  if (!currentRoom) return;
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me) return;
  setRaiseAmount((me.currentBet || 0) + me.chips);
}

function nudgeRaise(dir) {
  if (!currentRoom) return;
  const bb = Math.max(1, currentRoom.settings.bigBlind || 1);
  const cur = parseInt(document.getElementById('raise-amount')?.value, 10) || getMinRaiseTotal();
  setRaiseAmount(cur + dir * bb);
  highlightPresetBtn(null);
}

function updateRaiseBetDisplay() {
  const amountEl = document.getElementById('raise-amount');
  const valueEl = document.getElementById('raise-bet-value');
  const bbEl = document.getElementById('raise-bet-bb');
  const confirmBtn = document.getElementById('btn-raise-confirm');
  if (!amountEl) return;
  const amt = parseInt(amountEl.value, 10) || 0;
  const bb = Math.max(1, currentRoom?.settings?.bigBlind || 1);
  if (valueEl) valueEl.textContent = String(amt);
  if (bbEl) {
    const bbVal = amt / bb;
    bbEl.textContent = `${bbVal.toFixed(bbVal >= 100 || amt % bb === 0 ? 0 : 1)}BB`;
  }
  const me = currentRoom?.players?.find(p => p.id === mySocketId);
  const toCall = Math.max(0, (currentRoom?.gameState?.currentBet || 0) - (me?.currentBet || 0));
  const verb = toCall <= 0 ? 'BET' : 'RAISE';
  if (confirmBtn) confirmBtn.innerText = verb;
}

function syncRaiseSlider() {
  const amountEl = document.getElementById('raise-amount');
  const slider = document.getElementById('raise-slider');
  if (!currentRoom || !amountEl || !slider) return;
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me) return;
  const minRaise = getMinRaiseTotal();
  const maxRaise = (me.currentBet || 0) + me.chips;
  const val = parseInt(amountEl.value, 10) || minRaise;
  const span = Math.max(1, maxRaise - minRaise);
  amountEl.min = minRaise;
  amountEl.max = maxRaise;
  slider.min = 0;
  slider.max = 100;
  slider.value = Math.round(((Math.min(Math.max(val, minRaise), maxRaise) - minRaise) / span) * 100);
  updateRaiseBetDisplay();
}

function onRaiseSlider() {
  if (!currentRoom) return;
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me) return;
  const minRaise = getMinRaiseTotal();
  const maxRaise = (me.currentBet || 0) + me.chips;
  const pct = parseInt(document.getElementById('raise-slider').value, 10) || 0;
  const amount = Math.round(minRaise + (maxRaise - minRaise) * (pct / 100));
  document.getElementById('raise-amount').value = amount;
  highlightPresetBtn(null);
  updateRaiseBetDisplay();
}

function openRaisePanel() {
  if (!currentRoom) return;
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me || me.folded || me.allIn || isSpectator) return;
  const isMyTurn = currentRoom.gameState.currentPlayerIndex === me.seatIndex
    && currentRoom.gameState.status === 'playing';
  if (!isMyTurn) return;
  setRaiseMin();
  highlightPresetBtn(null);
  updateRaiseBetDisplay();
  document.getElementById('action-bar')?.classList.add('raise-open');
}

function closeRaisePanel() {
  document.getElementById('action-bar')?.classList.remove('raise-open');
  highlightPresetBtn(null);
}

function confirmRaise() {
  const amount = parseInt(document.getElementById('raise-amount')?.value, 10);
  if (!amount) return showToast('请选择加注金额', 2800, 'error');
  closeRaisePanel();
  socket.emit('action', { action: 'raise', amount });
  playSound('click');
}

/** 按庄家顺时针计算本手位置标签（小盲/大盲/枪口等） */
function computePositionMap(room) {
  const map = {}; // seatIndex -> { code, name }
  if (!room || room.gameState?.status !== 'playing') return map;
  const dealerSeat = room.gameState.dealerIndex;
  if (dealerSeat == null || dealerSeat < 0) return map;

  // 优先用服务端本手盲注座位（尤其 Heads-up 庄=小盲）
  const sbSeat = room.gameState.sbSeat;
  const bbSeat = room.gameState.bbSeat;
  if (room.gameState.headsUp && sbSeat >= 0 && bbSeat >= 0) {
    map[sbSeat] = { code: 'BTN', name: '庄/小盲', isDealer: true };
    map[bbSeat] = { code: 'BB', name: '大盲' };
    return map;
  }

  // 本手参与者：未坐出（弃牌仍保留位置）
  const seats = room.players
    .filter(p => !p.isSittingOut)
    .map(p => p.seatIndex)
    .sort((a, b) => a - b);
  if (seats.length < 2 || !seats.includes(dealerSeat)) return map;

  const start = seats.indexOf(dealerSeat);
  const order = [];
  for (let i = 0; i < seats.length; i++) {
    order.push(seats[(start + i) % seats.length]);
  }
  const n = order.length;

  // 中位命名：从枪口到关煞（BB 与 BTN 之间）
  const middleNames = (count) => {
    const tables = {
      0: [],
      1: [{ code: 'UTG', name: '枪口' }],
      2: [{ code: 'UTG', name: '枪口' }, { code: 'CO', name: '关煞' }],
      3: [{ code: 'UTG', name: '枪口' }, { code: 'HJ', name: '劫持' }, { code: 'CO', name: '关煞' }],
      4: [
        { code: 'UTG', name: '枪口' }, { code: 'UTG+1', name: '枪口+1' },
        { code: 'HJ', name: '劫持' }, { code: 'CO', name: '关煞' }
      ],
      5: [
        { code: 'UTG', name: '枪口' }, { code: 'UTG+1', name: '枪口+1' },
        { code: 'MP', name: '中间' }, { code: 'HJ', name: '劫持' }, { code: 'CO', name: '关煞' }
      ],
      6: [
        { code: 'UTG', name: '枪口' }, { code: 'UTG+1', name: '枪口+1' },
        { code: 'MP', name: '中间' }, { code: 'MP+1', name: '中间+1' },
        { code: 'HJ', name: '劫持' }, { code: 'CO', name: '关煞' }
      ],
      7: [
        { code: 'UTG', name: '枪口' }, { code: 'UTG+1', name: '枪口+1' }, { code: 'UTG+2', name: '枪口+2' },
        { code: 'MP', name: '中间' }, { code: 'MP+1', name: '中间+1' },
        { code: 'HJ', name: '劫持' }, { code: 'CO', name: '关煞' }
      ],
      8: [
        { code: 'UTG', name: '枪口' }, { code: 'UTG+1', name: '枪口+1' }, { code: 'UTG+2', name: '枪口+2' },
        { code: 'MP', name: '中间' }, { code: 'MP+1', name: '中间+1' }, { code: 'MP+2', name: '中间+2' },
        { code: 'HJ', name: '劫持' }, { code: 'CO', name: '关煞' }
      ]
    };
    if (tables[count]) return tables[count];
    const out = [];
    for (let i = 0; i < count; i++) {
      if (i === count - 1) out.push({ code: 'CO', name: '关煞' });
      else if (i === 0) out.push({ code: 'UTG', name: '枪口' });
      else out.push({ code: `+${i}`, name: `枪口+${i}` });
    }
    return out;
  };

  if (n === 2) {
    // Heads-up：庄家兼小盲；翻前庄/小盲先动，翻后大盲先动
    map[order[0]] = { code: 'BTN', name: '庄/小盲', isDealer: true };
    map[order[1]] = { code: 'BB', name: '大盲' };
    return map;
  }

  map[order[0]] = { code: 'BTN', name: '按钮', isDealer: true };
  map[order[1]] = { code: 'SB', name: '小盲' };
  map[order[2]] = { code: 'BB', name: '大盲' };
  const mid = middleNames(n - 3);
  mid.forEach((label, i) => {
    map[order[3 + i]] = label;
  });
  return map;
}

function cardsSignature(cards) {
  return (cards || []).map(c => (c && c.r != null ? `${c.r}${c.s}` : '_')).join('|');
}

/**
 * PokerNow PC：横向椭圆，座位贴桌边（外挂），中间留公共牌区。
 * relIndex 0 = 自己在底边，逆时针先往左。坐标为桌面比例。
 */
const POKERNOW_SEAT_LAYOUTS = {
  2: [[0.50, 0.94], [0.50, 0.06]],
  3: [[0.50, 0.94], [0.02, 0.48], [0.98, 0.48]],
  4: [[0.50, 0.94], [0.02, 0.50], [0.50, 0.06], [0.98, 0.50]],
  5: [[0.50, 0.94], [0.02, 0.62], [0.18, 0.10], [0.82, 0.10], [0.98, 0.62]],
  6: [
    [0.50, 0.94], [0.02, 0.58], [0.22, 0.08],
    [0.78, 0.08], [0.98, 0.58], [0.78, 0.92]
  ],
  7: [
    [0.50, 0.94], [0.16, 0.88], [0.02, 0.50], [0.22, 0.08],
    [0.78, 0.08], [0.98, 0.50], [0.84, 0.88]
  ],
  8: [
    [0.42, 0.94], [0.12, 0.82], [0.02, 0.48], [0.18, 0.10],
    [0.58, 0.06], [0.86, 0.14], [0.98, 0.52], [0.82, 0.90]
  ],
  9: [
    [0.50, 0.94],
    [0.18, 0.90],
    [0.02, 0.62],
    [0.06, 0.28],
    [0.28, 0.06],
    [0.72, 0.06],
    [0.94, 0.28],
    [0.98, 0.62],
    [0.82, 0.90]
  ],
  10: [
    [0.50, 0.94],
    [0.28, 0.92],
    [0.08, 0.78],
    [0.02, 0.48],
    [0.12, 0.16],
    [0.38, 0.05],
    [0.62, 0.05],
    [0.88, 0.16],
    [0.98, 0.48],
    [0.88, 0.78]
  ]
};

/**
 * 手机竖屏：座位贴桌边（左右 x≈0/1），中间留公共牌通道。
 * relIndex 0 = 自己（底边，实际由 hero 展示）。
 */
const POKERNOW_MOBILE_SEAT_LAYOUTS = {
  // 座位锚在毡缘内侧一点（贴边），中间留公共牌通道
  2: [[0.50, 0.92], [0.50, 0.08]],
  3: [[0.50, 0.92], [0.06, 0.48], [0.94, 0.48]],
  4: [[0.50, 0.92], [0.06, 0.55], [0.50, 0.08], [0.94, 0.55]],
  5: [[0.50, 0.92], [0.06, 0.68], [0.06, 0.30], [0.94, 0.30], [0.94, 0.68]],
  6: [
    [0.50, 0.92], [0.06, 0.70], [0.06, 0.36],
    [0.50, 0.08], [0.94, 0.36], [0.94, 0.70]
  ],
  7: [
    [0.50, 0.92], [0.06, 0.74], [0.06, 0.50], [0.06, 0.26],
    [0.50, 0.08], [0.94, 0.38], [0.94, 0.70]
  ],
  8: [
    [0.50, 0.92], [0.06, 0.76], [0.06, 0.54], [0.06, 0.30],
    [0.50, 0.08], [0.94, 0.30], [0.94, 0.54], [0.94, 0.76]
  ],
  9: [
    [0.50, 0.92],
    [0.06, 0.78],
    [0.06, 0.54],
    [0.06, 0.30],
    [0.50, 0.08],
    [0.94, 0.30],
    [0.94, 0.50],
    [0.94, 0.70],
    [0.94, 0.86]
  ],
  10: [
    [0.50, 0.92],
    [0.06, 0.82],
    [0.06, 0.64],
    [0.06, 0.42],
    [0.06, 0.24],
    [0.50, 0.08],
    [0.94, 0.24],
    [0.94, 0.42],
    [0.94, 0.64],
    [0.94, 0.82]
  ]
};

function seatPointFromPokernow(relIndex, maxPlayers, w, h, isMobile = false) {
  const layouts = isMobile ? POKERNOW_MOBILE_SEAT_LAYOUTS : POKERNOW_SEAT_LAYOUTS;
  const layout = layouts[maxPlayers] || POKERNOW_SEAT_LAYOUTS[maxPlayers];
  if (!layout || !layout[relIndex]) return null;
  const [fx, fy] = layout[relIndex];
  // 桌缘比例点 → 再沿法向外推，名牌落在毡面外侧（PokerNow）
  let nx = fx - 0.5;
  let ny = fy - 0.5;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  // 手机贴毡缘；PC 略外挂。过大易挤歪按钮
  const rimOut = isMobile
    ? Math.min(w, h) * (relIndex === 0 ? 0 : 0.012)
    : Math.min(w, h) * (relIndex === 0 ? 0 : 0.05);
  const x = fx * w + nx * rimOut;
  const y = fy * h + ny * rimOut;
  return { x, y, nx, ny };
}

/**
 * 跑道形桌边座席：沿桌边等弧长均匀分布。
 * t∈[0,1)，0 在底边中点，逆时针（屏幕坐标下先往左）。
 * 返回 {x,y, nx,ny}，n 为指向桌外的大致法向（用于注码偏移）。
 */
function stadiumSeatPoint(t, w, h, padRatio = 0.07) {
  const tt = ((t % 1) + 1) % 1;
  const padX = w * padRatio;
  const padY = h * padRatio;
  const iw = Math.max(1, w - 2 * padX);
  const ih = Math.max(1, h - 2 * padY);
  const ox = padX;
  const oy = padY;
  const cx = w / 2;
  const cy = h / 2;

  if (iw >= ih) {
    // 横向跑道：左右为短边圆弧
    const r = ih / 2;
    const straight = Math.max(0.0001, iw - ih);
    const halfCirc = Math.PI * r;
    const peri = 2 * straight + 2 * halfCirc;
    let d = tt * peri;
    const left = ox + r;
    const right = ox + iw - r;
    const topY = oy;
    const botY = oy + ih;
    const halfStraight = straight / 2;

    if (d <= halfStraight) {
      return { x: cx - d, y: botY, nx: 0, ny: 1 };
    }
    d -= halfStraight;
    if (d <= halfCirc) {
      const ang = Math.PI / 2 + (d / halfCirc) * Math.PI; // π/2 → 3π/2 via π（左半圆）
      const x = left + r * Math.cos(ang);
      const y = cy + r * Math.sin(ang);
      return { x, y, nx: Math.cos(ang), ny: Math.sin(ang) };
    }
    d -= halfCirc;
    if (d <= straight) {
      return { x: left + d, y: topY, nx: 0, ny: -1 };
    }
    d -= straight;
    if (d <= halfCirc) {
      const ang = -Math.PI / 2 + (d / halfCirc) * Math.PI; // -π/2 → π/2 via 0（右半圆）
      const x = right + r * Math.cos(ang);
      const y = cy + r * Math.sin(ang);
      return { x, y, nx: Math.cos(ang), ny: Math.sin(ang) };
    }
    d -= halfCirc;
    return { x: right - Math.min(d, halfStraight), y: botY, nx: 0, ny: 1 };
  }

  // 竖向跑道：上下为短边圆弧
  const r = iw / 2;
  const straight = Math.max(0.0001, ih - iw);
  const halfCirc = Math.PI * r;
  const peri = 2 * straight + 2 * halfCirc;
  let d = tt * peri;
  const top = oy + r;
  const bottom = oy + ih - r;
  const leftX = ox;
  const rightX = ox + iw;
  const quarter = halfCirc / 2;

  // 底弧中点 → 左侧
  if (d <= quarter) {
    const ang = Math.PI / 2 + (d / quarter) * (Math.PI / 2);
    return { x: cx + r * Math.cos(ang), y: bottom + r * Math.sin(ang), nx: Math.cos(ang), ny: Math.sin(ang) };
  }
  d -= quarter;
  // 左边直线上
  if (d <= straight) {
    return { x: leftX, y: bottom - d, nx: -1, ny: 0 };
  }
  d -= straight;
  // 顶弧左 → 右
  if (d <= halfCirc) {
    const ang = Math.PI + (d / halfCirc) * Math.PI;
    return { x: cx + r * Math.cos(ang), y: top + r * Math.sin(ang), nx: Math.cos(ang), ny: Math.sin(ang) };
  }
  d -= halfCirc;
  // 右边直线下
  if (d <= straight) {
    return { x: rightX, y: top + d, nx: 1, ny: 0 };
  }
  d -= straight;
  // 底弧右 → 中（从 ang=0 到 π/2，与左侧底弧对称）
  const ang = 0 + (Math.min(d, quarter) / quarter) * (Math.PI / 2);
  return { x: cx + r * Math.cos(ang), y: bottom + r * Math.sin(ang), nx: Math.cos(ang), ny: Math.sin(ang) };
}

function updateHeroCardsDom(me) {
  const heroCards = document.getElementById('hero-cards');
  if (!heroCards) return;
  const next = (me && me.holeCards?.length > 0 && !isSpectator) ? me.holeCards : [];
  const key = cardsSignature(next);
  const handNo = String(currentRoom?.gameState?.handNumber ?? '');
  if (heroCards.dataset.cardsKey === key) return;
  // 新手牌才播一次发牌动画；同一手内状态刷新不再重绘/抖动
  const shouldAnimate = next.length >= 2 && heroCards.dataset.handNo !== handNo;
  heroCards.dataset.cardsKey = key;
  heroCards.dataset.handNo = handNo;
  if (!next.length) {
    heroCards.innerHTML = '';
    return;
  }
  heroCards.innerHTML = next.map(c => cardHtml(c)).join('');
  if (shouldAnimate) {
    heroCards.querySelectorAll('.card').forEach(el => {
      el.classList.add('deal-anim');
      el.addEventListener('animationend', () => el.classList.remove('deal-anim'), { once: true });
    });
  }
}

/** 自己名牌：昵称 + 筹码；下注筹码圆点；庄家钮 */
function updateHeroStackDom(me) {
  const el = document.getElementById('hero-stack');
  const betChip = document.getElementById('hero-bet-chip');
  const dealerEl = document.getElementById('hero-dealer');
  if (!el) return;
  if (!me || isSpectator) {
    el.innerHTML = '';
    el.classList.remove('show');
    if (betChip) betChip.hidden = true;
    if (dealerEl) dealerEl.hidden = true;
    return;
  }
  const name = escapeHtml(me.name || '我');
  const chips = formatChips(me.chips);
  const key = `${me.name}|${me.chips}|${me.currentBet || 0}`;
  if (el.dataset.stackKey !== key) {
    el.dataset.stackKey = key;
    el.innerHTML = `<div class="hero-name">${name}</div><div class="hero-chips">${chips}</div>`;
    el.classList.add('show');
  }
  if (betChip) {
    const bet = me.currentBet || 0;
    if (bet > 0) {
      betChip.hidden = false;
      betChip.textContent = formatChips(bet);
    } else {
      betChip.hidden = true;
    }
  }
  if (dealerEl) {
    const isDealer = currentRoom?.gameState?.dealerIndex === me.seatIndex;
    dealerEl.hidden = !isDealer;
  }
}

function updateCommunityCardsDom() {
  const ccDiv = document.getElementById('community-cards');
  if (!ccDiv) return;
  const cards = currentRoom?.gameState?.communityCards || [];
  const key = cardsSignature(cards);
  if (ccDiv.dataset.cardsKey === key) return;
  ccDiv.dataset.cardsKey = key;
  ccDiv.innerHTML = cards.map(c => cardHtml(c)).join('');
}

function renderTable() {
  if (!currentRoom) return;
  renderSidebar();
  const seatsContainer = document.getElementById('seats-container');
  const tableEl = document.getElementById('poker-table');
  const tableWidth = tableEl.offsetWidth;
  const tableHeight = tableEl.offsetHeight;
  const isMobileLayout = window.innerWidth <= 900 || window.matchMedia('(orientation: portrait)').matches;
  const maxPlayers = currentRoom.settings.maxPlayers;
  const seatMap = {};
  currentRoom.players.forEach(p => { seatMap[p.seatIndex] = p; });
  const positionMap = computePositionMap(currentRoom);
  const meForSeat = currentRoom.players.find(p => p.id === mySocketId);
  const anchorSeat = (meForSeat?.seatIndex ?? 0);
  // 座位锚在桌外缘；半宽用于居中定位
  const seatHalfW = isMobileLayout ? 36 : 50;
  const seatHalfH = isMobileLayout ? 22 : 26;
  const layoutKey = `${Math.round(tableWidth)}x${Math.round(tableHeight)}:${maxPlayers}:${anchorSeat}:${isMobileLayout ? 1 : 0}:pn-v7`;
  const layoutChanged = seatsContainer.dataset.layoutKey !== layoutKey;
  if (layoutChanged) {
    seatsContainer.dataset.layoutKey = layoutKey;
    seatsContainer.innerHTML = '';
  }

  for (let seatIdx = 0; seatIdx < maxPlayers; seatIdx++) {
    // 相对自己旋转：自己在底边；手机用竖屏站位，PC 用横屏站位
    const relIndex = ((seatIdx - anchorSeat) % maxPlayers + maxPlayers) % maxPlayers;
    const t = relIndex / maxPlayers;
    const pt = seatPointFromPokernow(relIndex, maxPlayers, tableWidth, tableHeight, isMobileLayout)
      || stadiumSeatPoint(t, tableWidth, tableHeight, isMobileLayout ? 0.12 : 0.1);
    const x = pt.x;
    const y = pt.y;
    const betOffX = Math.round(-(pt.nx || 0) * 22);
    const betOffY = Math.round(-(pt.ny || 0) * 18);

    let seat = seatsContainer.querySelector(`.seat[data-seat="${seatIdx}"]`);
    if (!seat) {
      seat = document.createElement('div');
      seat.dataset.seat = seatIdx;
      seatsContainer.appendChild(seat);
    }
    const p = seatMap[seatIdx];
    const isMeSeat = p && p.id === mySocketId;
    const cardsOnLeft = x >= tableWidth * 0.5;
    seat.style.left = (x - seatHalfW) + 'px';
    seat.style.top = (y - seatHalfH) + 'px';

    if (!p) {
      const emptyKey = `empty:${relIndex}`;
      if (seat.dataset.renderKey !== emptyKey) {
        seat.dataset.renderKey = emptyKey;
        seat.className = 'seat empty';
        seat.innerHTML = `
          <span class="seat-num">${relIndex + 1}</span>
          <div class="seat-sit">SIT</div>
        `;
      }
      seat.classList.toggle('cards-left', cardsOnLeft);
      continue;
    }

    const isShowdown = currentRoom.gameState.status === 'playing'
      && currentRoom.gameState.bettingRound === 'showdown';
    const mask = p.shownHoleMask || [false, false];
    const anyShown = !!(mask[0] || mask[1]);
    const hasHoleSlots = Array.isArray(p.holeCards) && p.holeCards.length > 0;
    const cardsRevealed = isShowdown && (anyShown || (!p.folded && hasHoleSlots));
    const isActive = currentRoom.gameState.currentPlayerIndex === p.seatIndex
      && !p.folded
      && !p.disconnected
      && currentRoom.gameState.status === 'playing'
      && currentRoom.gameState.bettingRound !== 'showdown';
    const pos = positionMap[p.seatIndex];
    const renderKey = [
      p.id, p.chips, p.currentBet, p.folded, p.allIn, p.disconnected, p.isSittingOut, p.pendingJoin,
      isActive, cardsRevealed, cardsSignature(p.holeCards), (mask[0] ? 1 : 0) + (mask[1] ? 2 : 0),
      pos?.code || '',
      currentRoom.gameState.dealerIndex === p.seatIndex ? 'D' : '',
      cardsOnLeft ? 'L' : 'R'
    ].join(':');
    if (seat.dataset.renderKey === renderKey) {
      seat.classList.toggle('cards-left', cardsOnLeft && !isMeSeat);
      continue;
    }
    seat.dataset.renderKey = renderKey;

    seat.className = 'seat';
    if (p.id === mySocketId) seat.classList.add('me');
    if (p.disconnected) seat.classList.add('away');
    if (isActive) seat.classList.add('active');
    if (p.folded || p.isSittingOut || p.disconnected) seat.classList.add('folded');
    if (cardsRevealed) seat.classList.add('showdown-reveal');
    if (cardsOnLeft && !isMeSeat) seat.classList.add('cards-left');
    // 自己手牌只在底部 hero 区展示，座位上不再重复亮牌（避免挡住）

    let cardsHtml = `<div class="seat-cards${cardsRevealed ? ' revealed' : ''}">`;
    if (p.id !== mySocketId) {
      if (isShowdown && hasHoleSlots) {
        // 摊牌：已秀正面，未秀牌背
        p.holeCards.forEach((c, i) => {
          cardsHtml += c ? cardHtml(c) : '<div class="card card-back"></div>';
        });
      } else if (!p.folded && !p.disconnected && currentRoom.gameState.status === 'playing' && !isShowdown) {
        cardsHtml += '<div class="card card-back"></div><div class="card card-back"></div>';
      }
    } else if (isShowdown && hasHoleSlots && anyShown) {
      // 自己座位：仅在有对外秀牌时重复展示（主要看 hero 区）
      p.holeCards.forEach((c, i) => {
        if (mask[i]) cardsHtml += cardHtml(c);
        else cardsHtml += '<div class="card card-back"></div>';
      });
    }
    cardsHtml += '</div>';

    let statusTag = '';
    if (p.disconnected) statusTag = '<div class="seat-status-tag">断线</div>';
    else if (p.pendingJoin) statusTag = '<div class="seat-status-tag">下下手</div>';
    else if (p.isSittingOut) statusTag = '<div class="seat-status-tag">暂离</div>';
    else if (p.allIn) statusTag = '<div class="seat-status-tag">全下</div>';
    else if (p.folded) statusTag = '<div class="seat-status-tag">弃牌</div>';

    const posClass = pos ? `pos-${(pos.code || '').toLowerCase().replace('+', 'p')}` : '';
    const posHtml = pos
      ? `<div class="seat-position ${posClass}" title="${escapeHtml(pos.code)}">${escapeHtml(pos.name)}</div>`
      : '';
    const showDealerChip = currentRoom.gameState.dealerIndex === p.seatIndex
      || !!pos?.isDealer;

    seat.innerHTML = `
      <span class="seat-num">${relIndex + 1}</span>
      ${statusTag}
      ${posHtml}
      ${cardsHtml}
      <div class="seat-info">
        <div class="seat-name">${escapeHtml(p.name)}${p.id === mySocketId ? ' ·我' : ''}</div>
        <div class="seat-chips">${formatChips(p.chips)}</div>
        <div class="seat-timer-bar" aria-hidden="true"><div class="seat-timer-fill"></div></div>
      </div>
      ${showDealerChip ? '<div class="dealer-button">D</div>' : ''}
      ${p.currentBet > 0 ? `<div class="seat-bet">${formatChips(p.currentBet)}</div>` : ''}
    `;
  }

  // 公共牌 + 底池（内容未变则不重绘）
  updateCommunityCardsDom();
  const totalPot = getTotalPot();
  const potDiv = document.getElementById('pot-display');
  // 桌心胶囊只显示数字（对齐常见桌面习惯）；空闲等待时隐藏
  const potText = totalPot > 0 || currentRoom.gameState.status === 'playing'
    ? formatChips(totalPot)
    : '';
  if (potDiv && potDiv.textContent !== potText) potDiv.textContent = potText;

  // 桌内右上：房主 + 盲注
  const ownerEl = document.getElementById('table-owner');
  const blindsEl = document.getElementById('table-blinds');
  const hostName = currentRoom.players.find(p => p.isHost)?.name
    || currentRoom.players.find(p => p.id === currentRoom.hostId)?.name
    || '';
  const sb = currentRoom.settings?.smallBlind ?? 1;
  const bb = currentRoom.settings?.bigBlind ?? 2;
  const ownerText = hostName ? `OWNER: ${hostName}` : '';
  const blindsText = `NLH · ${sb} / ${bb}`;
  if (ownerEl && ownerEl.textContent !== ownerText) ownerEl.textContent = ownerText;
  if (blindsEl && blindsEl.textContent !== blindsText) blindsEl.textContent = blindsText;

  // 自己的大牌（底部 hero）+ 筹码 + 当前牌型 + 秀牌栏
  const me = currentRoom.players.find(p => p.id === mySocketId);
  updateHeroCardsDom(me);
  updateHeroStackDom(me);
  updateHeroHandRank(me);
  updateShowCardsBar(me);

  // 开局 / 下一手
  const startOverlay = document.getElementById('start-overlay');
  const startBtn = document.getElementById('btn-start-game');
  const waitingText = document.getElementById('waiting-text');
  const nextHandOverlay = document.getElementById('next-hand-overlay');
  const isHost = amIHost();
  if (currentRoom.gameState.status === 'waiting') {
    startOverlay.classList.remove('hidden');
    nextHandOverlay.classList.add('hidden');
    if (isHost) {
      startBtn.style.display = 'inline-block';
      waitingText.style.display = 'none';
      const activePlayers = currentRoom.players.filter(p => {
        if ((p.chips || 0) <= 0) return false;
        // 中途入座 / 待补码 / 断线占座都算可开局人数
        if (p.hasRebought || p.pendingJoin || (p.pendingRebuy || 0) > 0) return true;
        if (p.disconnected) return true;
        // 仅主动暂离不算
        if (p.wantSitOut && p.isSittingOut) return false;
        return !p.isSittingOut;
      });
      const approvedSpectators = (currentRoom.spectators || []).filter(s => s.joinApproved).length;
      const totalPotential = activePlayers.length + approvedSpectators;
      if (totalPotential < 2) {
        startBtn.disabled = true;
        startBtn.innerText = '至少需要 2 人';
      } else {
        startBtn.disabled = false;
        startBtn.innerText = '开始游戏';
      }
    } else {
      startBtn.style.display = 'none';
      waitingText.style.display = 'block';
      waitingText.innerText = '等待房主开局…';
    }
  } else {
    startOverlay.classList.add('hidden');
  }

  // 行动区
  const turnIndicator = document.getElementById('turn-indicator');
  const actionStatus = document.getElementById('action-status');
  const actionBar = document.getElementById('action-bar');
  const isMyTurn = currentRoom.gameState.currentPlayerIndex === me?.seatIndex
    && !me?.folded
    && !me?.allIn
    && currentRoom.gameState.status === 'playing'
    && !isSpectator;

  const btnFold = document.getElementById('btn-fold');
  const btnCheck = document.getElementById('btn-check');
  const btnCall = document.getElementById('btn-call');
  const btnRaise = document.getElementById('btn-raise');
  const btnAllin = document.getElementById('btn-allin');
  const actionsRow = document.getElementById('actions-row');
  const waitingActions = document.getElementById('waiting-actions');
  const isWaitingLobby = currentRoom.gameState.status === 'waiting';

  const heroZone = document.getElementById('hero-zone');
  if (actionBar) {
    actionBar.classList.toggle('in-hand', !isWaitingLobby);
    actionBar.classList.toggle('my-turn', !!isMyTurn);
    if (!isMyTurn) actionBar.classList.remove('raise-open');
  }
  if (heroZone) heroZone.classList.toggle('is-my-turn', !!isMyTurn);

  if (waitingActions) waitingActions.classList.toggle('show', isWaitingLobby);
  if (actionsRow) actionsRow.style.display = '';

  if (isMyTurn) {
    turnIndicator?.classList.remove('hidden');
    if (actionStatus) actionStatus.innerText = '';
  } else {
    turnIndicator?.classList.add('hidden');
    closeRaisePanel();
    highlightPresetBtn(null);
    const amountElClear = document.getElementById('raise-amount');
    if (amountElClear) amountElClear.value = '0';
    if (actionStatus) {
      if (currentRoom.gameState.status === 'playing' && currentRoom.gameState.bettingRound !== 'showdown') {
        const currentPlayer = currentRoom.players.find(p => p.seatIndex === currentRoom.gameState.currentPlayerIndex);
        actionStatus.innerText = currentPlayer ? `等待 ${currentPlayer.name} 行动…` : '';
      } else if (isWaitingLobby) {
        actionStatus.innerText = '分享房间号，喊朋友上车';
      } else if (currentRoom.gameState.bettingRound === 'showdown') {
        actionStatus.innerText = '本手结束 — 等待下一手…';
      } else {
        actionStatus.innerText = '';
      }
    }
  }

  const disableActions = isSpectator || !isMyTurn;
  const toCall = (currentRoom.gameState.currentBet || 0) - (me?.currentBet || 0);
  const canCheck = toCall <= 0;
  const actualCall = Math.min(Math.max(toCall, 0), me?.chips || 0);

  btnFold.disabled = disableActions;
  btnCheck.disabled = disableActions || !canCheck;
  btnCall.disabled = disableActions || canCheck;
  btnRaise.disabled = disableActions;
  if (btnAllin) btnAllin.disabled = disableActions;

  // PokerNow：四键始终可见，不可用置灰
  btnCheck.classList.toggle('is-disabled', disableActions || !canCheck);
  btnCall.classList.toggle('is-disabled', disableActions || canCheck);
  btnRaise.classList.toggle('is-disabled', disableActions);
  btnFold.classList.toggle('is-disabled', disableActions);
  btnCheck.classList.remove('hidden-btn');
  btnCall.classList.remove('hidden-btn');
  btnRaise.classList.remove('hidden-btn');
  btnFold.classList.remove('hidden-btn');

  btnFold.innerText = 'FOLD';
  btnCheck.innerText = 'CHECK';
  btnCall.innerText = actualCall > 0 ? `CALL ${formatChips(actualCall)}` : 'CALL';
  btnRaise.innerText = canCheck ? 'BET' : 'RAISE';

  if (isMyTurn) {
    const minRaise = getMinRaiseTotal();
    const maxRaise = (me.currentBet || 0) + me.chips;
    const amountEl = document.getElementById('raise-amount');
    if (amountEl) {
      amountEl.min = minRaise;
      amountEl.max = maxRaise;
      const cur = parseInt(amountEl.value, 10) || 0;
      if (!cur || cur < minRaise) {
        amountEl.value = String(Math.min(minRaise, maxRaise));
      } else if (cur > maxRaise) {
        amountEl.value = String(maxRaise);
      }
    }
    if (actionBar?.classList.contains('raise-open')) {
      syncRaiseSlider();
      updateRaiseBetDisplay();
    }
  }

  const extendBtn = document.getElementById('btn-extend-timer');
  if (currentRoom.gameState.timerEnd && currentRoom.gameState.status === 'playing' && currentRoom.settings.timerEnabled) {
    const endTime = currentRoom.gameState.timerEnd;
    if (endTime > Date.now()) {
      startTimerCountdown(endTime, isMyTurn);
    } else {
      extendBtn?.classList.toggle('show', !!isMyTurn);
      extendBtn?.classList.remove('urgent');
      document.getElementById('hero-timer-bar')?.setAttribute('hidden', '');
      applyTimerProgress(0, false);
    }
  } else {
    extendBtn?.classList.toggle('show', !!isMyTurn);
    extendBtn?.classList.remove('urgent');
    document.getElementById('hero-timer-bar')?.setAttribute('hidden', '');
    applyTimerProgress(0, false);
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    activeTimerEnd = 0;
  }
}

// -------------------------
// GAME ACTIONS
// -------------------------
function startGame() {
  socket.emit('start-game');
  playSound('click');
}

function startNextHand() {
  socket.emit('start-next-hand');
  playSound('click');
  document.getElementById('next-hand-overlay').classList.add('hidden');
}

function sendAction(action) {
  socket.emit('action', { action });
  playSound('click');
}

function sendRaise() {
  openRaisePanel();
}

function sendAllIn() {
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me) return;
  socket.emit('action', { action: 'allin' });
  playSound('click');
}

function leaveRoom() {
  if (sessionClockTimer) { clearInterval(sessionClockTimer); sessionClockTimer = null; }
  if (nextHandInterval) { clearInterval(nextHandInterval); nextHandInterval = null; }
  closeHandHistory();
  // 主动离开：通知服务端保留座位，不断开 socket（大厅仍用同一连接）
  if (socket.connected) socket.emit('leave-room');
  currentRoom = null;
  isSpectator = false;
  handHistoryIndex = -1;
  handHistoryTotal = 0;
  handHistoryCache = null;
  if (window.App) {
    window.App.leaveGame();
  } else {
    location.reload();
  }
}

function updateSitOutButton() {
  const menuSit = document.getElementById('menu-sit-out-btn');
  const menuLeave = document.getElementById('menu-leave-seat-btn');
  if (!menuSit && !menuLeave) return;
  if (isSpectator) {
    if (menuSit) menuSit.style.display = 'none';
    if (menuLeave) menuLeave.style.display = 'none';
    return;
  }
  if (menuSit) menuSit.style.display = '';
  if (menuLeave) menuLeave.style.display = '';
  const me = currentRoom?.players?.find(p => p.id === mySocketId);
  const pending = !!me?.wantSitOut;
  const sitting = !!me?.isSittingOut;
  if (!menuSit) return;
  if (sitting) {
    menuSit.textContent = '▶ 回桌';
    menuSit.title = '取消暂离，下下手继续打牌';
    menuSit.classList.add('menu-sit-in');
  } else if (pending) {
    menuSit.textContent = '▶ 取消暂离';
    menuSit.title = '取消本手结束后的暂离';
    menuSit.classList.add('menu-sit-in');
  } else {
    menuSit.textContent = '⏸ 暂离';
    menuSit.title = '暂离留位；连续2手未操作也会自动暂离';
    menuSit.classList.remove('menu-sit-in');
  }
}

function toggleSitOut() {
  if (isSpectator || !socket?.connected) return;
  const me = currentRoom?.players?.find(p => p.id === mySocketId);
  if (!me) return;
  if (me.isSittingOut) {
    socket.emit('sit-in');
    return;
  }
  if (me.wantSitOut) {
    // 取消待生效的暂离：用 sit-in 清掉标记
    socket.emit('sit-in');
    return;
  }
  socket.emit('sit-out');
}

async function leaveSeat() {
  if (isSpectator || !socket?.connected) return;
  const me = currentRoom?.players?.find(p => p.id === mySocketId);
  if (!me) return;
  const ok = await showConfirm('确定退出座位？筹码将退回账户，座位会释放。', {
    danger: true,
    confirmText: '退出座位'
  });
  if (!ok) return;
  socket.emit('leave-seat');
}

// -------------------------
// HAND HISTORY（本局手牌翻页）
// -------------------------
function openHandHistory() {
  document.getElementById('hand-history-modal')?.classList.add('show');
  requestHandHistory('latest');
}

function closeHandHistory() {
  document.getElementById('hand-history-modal')?.classList.remove('show');
}

function requestHandHistory(index) {
  if (!socket.connected) return;
  socket.emit('get-hand-history', { index });
}

function handHistoryPrev() {
  if (handHistoryIndex <= 0) return;
  requestHandHistory(handHistoryIndex - 1);
}

function handHistoryNext() {
  if (handHistoryIndex < 0 || handHistoryIndex >= handHistoryTotal - 1) return;
  requestHandHistory(handHistoryIndex + 1);
}

function formatBb(chips, bb) {
  const v = Number(chips) || 0;
  const blind = Math.max(1, Number(bb) || 20);
  const n = v / blind;
  if (Number.isInteger(n)) return `${n} BB`;
  return `${(Math.round(n * 10) / 10).toFixed(1)} BB`;
}

function positionsForHandLog(hand) {
  return computePositionMap({
    gameState: { status: 'playing', dealerIndex: hand.dealerSeat },
    players: (hand.players || []).map(p => ({
      seatIndex: p.seatIndex,
      isSittingOut: false,
      id: String(p.userId || p.seatIndex)
    }))
  });
}

function hhActionVerb(action, { isBet = false } = {}) {
  if (action === 'sb') return '小盲';
  if (action === 'bb') return '大盲';
  if (action === 'fold') return '弃牌';
  if (action === 'check') return '让牌';
  if (action === 'call') return '跟注';
  if (action === 'raise') return isBet ? '下注' : '加注';
  if (action === 'allin') return isBet ? '下注' : '加注';
  return ACTION_ZH[action] || action;
}

function hhBubbleText(a, { isBet = false, bb } = {}) {
  const verb = hhActionVerb(a.action, { isBet });
  if (a.action === 'fold' || a.action === 'check') return verb;
  const amt = a.action === 'raise' || a.action === 'allin'
    ? (a.streetBet || a.amount || 0)
    : (a.amount || 0);
  if (!amt) return verb;
  const allinTag = (a.allIn || a.action === 'allin')
    ? '<span class="hh-allin">全押</span>'
    : '';
  return `${verb} ${formatBb(amt, bb)}${allinTag}`;
}

function hhPlayerRow(a, posMap, bb, opts = {}) {
  const pos = posMap[a.seatIndex];
  const posClass = pos ? `pos-${(pos.code || '').toLowerCase().replace('+', 'p')}` : '';
  const posHtml = pos
    ? `<span class="hh-pos-tag ${posClass}">${escapeHtml(pos.name)}</span>`
    : '';
  const bubble = opts.hideBubble
    ? ''
    : `<div class="hh-bubble">${hhBubbleText(a, { isBet: opts.isBet, bb })}</div>`;
  const cards = (opts.showCards && opts.holeCards?.length)
    ? `<div class="hh-mini-cards">${opts.holeCards.map(c => cardHtml(c)).join('')}</div>`
    : '';
  const winBox = opts.winAmount
    ? `<div class="hh-win-box">获胜 <span class="hh-win-amt">${formatBb(opts.winAmount, bb)}</span></div>`
    : '';
  return `<div class="hh-row">
    <div class="hh-avatar" style="background:${avatarColor(a.name)}">${escapeHtml(avatarInitials(a.name))}</div>
    <div class="hh-row-main">
      <div class="hh-row-name">${escapeHtml(a.name)}</div>
      ${posHtml}
      ${bubble}
      ${cards}
      ${winBox}
    </div>
  </div>`;
}

function renderHandHistoryPage() {
  const label = document.getElementById('hh-page-label');
  const body = document.getElementById('hh-body');
  const prev = document.getElementById('hh-prev');
  const next = document.getElementById('hh-next');
  if (!body || !label) return;

  if (prev) prev.disabled = handHistoryIndex <= 0;
  if (next) next.disabled = handHistoryIndex < 0 || handHistoryIndex >= handHistoryTotal - 1;

  if (!handHistoryTotal || !handHistoryCache) {
    label.textContent = '0 / 0';
    body.innerHTML = '<p class="hh-empty">暂无已完成的手牌<br>打完一手后可在此查看</p>';
    return;
  }

  const hand = handHistoryCache;
  const bb = hand.bigBlind || currentRoom?.settings?.bigBlind || 20;
  label.textContent = `第 ${hand.handNumber} 手 · ${handHistoryIndex + 1}/${handHistoryTotal}`;

  const posMap = positionsForHandLog(hand);
  const playerBySeat = {};
  (hand.players || []).forEach(p => { playerBySeat[p.seatIndex] = p; });

  // 拆分盲注列 / 翻前及后续
  const blinds = [];
  const byStreet = { preflop: [], flop: [], turn: [], river: [] };
  let pot = 0;
  const potAt = { blinds: 0, preflop: 0, flop: 0, turn: 0, river: 0 };

  (hand.actions || []).forEach(a => {
    if (a.action === 'sb' || a.action === 'bb') {
      blinds.push(a);
      pot += a.amount || 0;
      potAt.blinds = pot;
      return;
    }
    const street = a.street || 'preflop';
    if (!byStreet[street]) byStreet[street] = [];
    // 进入该街时记录起始底池
    if (byStreet[street].length === 0) {
      if (street === 'preflop') potAt.preflop = pot;
      else if (street === 'flop') potAt.flop = pot;
      else if (street === 'turn') potAt.turn = pot;
      else if (street === 'river') potAt.river = pot;
    }
    byStreet[street].push(a);
    pot += a.amount || 0;
  });
  if (!byStreet.preflop.length) potAt.preflop = potAt.blinds;
  // 若某街无行动但有公共牌，用当前累计底池
  if (!byStreet.flop.length && (hand.communityCards || []).length >= 3) potAt.flop = pot;
  if (!byStreet.turn.length && (hand.communityCards || []).length >= 4) potAt.turn = pot;
  if (!byStreet.river.length && (hand.communityCards || []).length >= 5) potAt.river = pot;

  const board = hand.communityCards || [];

  function renderStreetRows(list, streetKey) {
    let hadAggression = false;
    let html = '';
    list.forEach((a, idx) => {
      const isBet = (a.action === 'raise' || a.action === 'allin')
        && streetKey !== 'preflop'
        && !hadAggression;
      if (a.action === 'raise' || (a.action === 'allin' && ((a.raiseBy || 0) > 0 || (a.streetBet || 0) > 0))) {
        hadAggression = true;
      }
      const pInfo = playerBySeat[a.seatIndex];
      const isLastForPlayer = !list.slice(idx + 1).some(x => x.seatIndex === a.seatIndex);
      const shouldShowCards = isLastForPlayer
        && !!(pInfo?.holeCards?.length)
        && (pInfo.showed || pInfo.isMe)
        && (a.allIn || a.action === 'allin' || streetKey === 'river');

      html += hhPlayerRow(a, posMap, bb, {
        isBet,
        showCards: shouldShowCards,
        holeCards: pInfo?.holeCards
      });

      if (a.action === 'raise' || a.action === 'allin') {
        const verb = isBet ? '下注' : '加注';
        const showAmt = a.streetBet || a.raiseBy || a.amount || 0;
        if (showAmt) html += `<div class="hh-summary">${verb} ${formatBb(showAmt, bb)}</div>`;
      } else if (a.action === 'call' && (a.amount || 0) > 0 && hadAggression) {
        html += `<div class="hh-summary">跟注 ${formatBb(a.amount, bb)}</div>`;
      }
    });
    return html;
  }

  const winRows = (hand.players || [])
    .filter(p => (p.wonAmount || 0) > 0)
    .map(p => hhPlayerRow(
      { name: p.name, seatIndex: p.seatIndex, action: 'check', amount: 0 },
      posMap,
      bb,
      {
        hideBubble: true,
        showCards: !!(p.holeCards?.length),
        holeCards: p.holeCards,
        winAmount: p.wonAmount
      }
    )).join('');

  const resultStrip = `<div class="hh-result-strip">
    <div class="hh-result-title">本手输赢 · 底池 ${formatBb(hand.potTotal, bb)}</div>
    ${(hand.players || []).slice().sort((a, b) => a.seatIndex - b.seatIndex).map(p => {
      const profit = p.profit || 0;
      const cls = profit > 0 ? 'up' : (profit < 0 ? 'down' : 'flat');
      const signed = profit > 0 ? `+${formatBb(profit, bb)}` : (profit < 0 ? `-${formatBb(-profit, bb)}` : '0 BB');
      return `<div class="hh-result-player">
        <span>${escapeHtml(p.name)}${p.isMe ? ' ·我' : ''}</span>
        <span class="${cls}">${signed}</span>
      </div>`;
    }).join('')}
  </div>`;

  const lastKey = board.length >= 5 || byStreet.river.length ? 'river'
    : board.length >= 4 || byStreet.turn.length ? 'turn'
    : board.length >= 3 || byStreet.flop.length ? 'flop'
    : 'preflop';

  const cols = [
    {
      key: 'blinds',
      title: '盲注',
      pot: 0,
      board: [],
      body: blinds.map(a => hhPlayerRow(a, posMap, bb, {})).join('')
        || '<div class="hh-empty" style="padding:16px 4px;font-size:0.75rem;">无盲注</div>'
    },
    {
      key: 'preflop',
      title: '翻牌前',
      pot: potAt.preflop || potAt.blinds,
      board: [],
      body: renderStreetRows(byStreet.preflop, 'preflop')
        || '<div class="hh-empty" style="padding:16px 4px;font-size:0.75rem;">无行动</div>'
    },
    {
      key: 'flop',
      title: '翻牌',
      pot: potAt.flop,
      board: board.slice(0, 3),
      body: renderStreetRows(byStreet.flop, 'flop')
    },
    {
      key: 'turn',
      title: '转牌',
      pot: potAt.turn,
      board: board.slice(0, 4),
      body: renderStreetRows(byStreet.turn, 'turn')
    },
    {
      key: 'river',
      title: '河牌',
      pot: potAt.river || (lastKey === 'river' ? hand.potTotal : 0),
      board: board.slice(0, 5),
      body: renderStreetRows(byStreet.river, 'river')
    }
  ];

  const visibleCols = cols.filter((c) => {
    if (c.key === 'blinds' || c.key === 'preflop') return true;
    if (c.key === 'flop') return board.length >= 3 || byStreet.flop.length;
    if (c.key === 'turn') return board.length >= 4 || byStreet.turn.length;
    if (c.key === 'river') return board.length >= 5 || byStreet.river.length;
    return true;
  }).map(c => {
    if (c.key !== lastKey) return c;
    return {
      ...c,
      pot: c.pot || hand.potTotal,
      body: (c.body || '') + winRows + resultStrip
    };
  });

  body.innerHTML = `<div class="hh-timeline">${visibleCols.map(c => `
    <div class="hh-col">
      <div class="hh-col-head">
        <div class="hh-col-title">${c.title}</div>
        ${c.pot > 0 ? `<div class="hh-col-pot">${formatBb(c.pot, bb)}</div>` : ''}
        ${c.board.length ? `<div class="hh-col-board">${c.board.map(card => cardHtml(card)).join('')}</div>` : ''}
      </div>
      <div class="hh-col-body">${c.body || ''}</div>
    </div>
  `).join('')}</div>`;
}

// Shift+滚轮翻手；普通滚轮留给横向/纵向滚动
document.getElementById('hand-history-modal')?.addEventListener('wheel', (e) => {
  if (!document.getElementById('hand-history-modal')?.classList.contains('show')) return;
  if (!e.shiftKey) return;
  if (Math.abs(e.deltaY) < 20) return;
  e.preventDefault();
  if (e.deltaY < 0) handHistoryPrev();
  else handHistoryNext();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (!document.getElementById('hand-history-modal')?.classList.contains('show')) return;
  if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'ArrowLeft') {
    e.preventDefault();
    handHistoryPrev();
  }
  if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'ArrowRight') {
    e.preventDefault();
    handHistoryNext();
  }
  if (e.key === 'Escape') closeHandHistory();
});

function formatSessionLeft(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function startSessionClockUI(endsAt) {
  const clock = document.getElementById('session-clock');
  if (!clock) return;
  if (sessionClockTimer) { clearInterval(sessionClockTimer); sessionClockTimer = null; }
  if (!endsAt) {
    const mins = currentRoom?.settings?.sessionMinutes;
    clock.textContent = mins ? '' : '不限时';
    clock.className = 'session-clock';
    if (!mins) return;
  }
  const tick = () => {
    if (!endsAt) {
      clock.textContent = '';
      return;
    }
    const left = endsAt - Date.now();
    if (currentRoom?.pendingSettle || left <= 0) {
      clock.textContent = '即将结算';
      clock.className = 'session-clock urgent';
      return;
    }
    clock.textContent = formatSessionLeft(left);
    clock.className = 'session-clock';
    if (left <= 60 * 1000) clock.classList.add('urgent');
    else if (left <= 5 * 60 * 1000) clock.classList.add('warn');
  };
  tick();
  sessionClockTimer = setInterval(tick, 500);
}

// -------------------------
// CHAT + 表情（自研面板，非第三方版权素材）
// -------------------------
const EMOTE_CATALOG = [
  { id: 'react', name: '反应', items: ['😂', '🤣', '😆', '😅', '😏', '😎', '🤩', '🥳', '😮', '🫡'] },
  { id: 'feel', name: '情绪', items: ['😍', '🥰', '😘', '😭', '😢', '😤', '😠', '🤬', '😱', '🤯', '😳', '🥵'] },
  { id: 'play', name: '牌桌', items: ['👍', '👎', '👏', '💪', '🙏', '🤝', '✌️', '🤞', '👀', '🤔', '😴', '🥱'] },
  { id: 'fun', name: '趣味', items: ['🔥', '💀', '👻', '💩', '🤡', '😈', '🤖', '💯', '⭐', '✨', '🎉', '💔', '❤️', '💰', '🃏', '🎯', '🏆', '🍾', '🙈', '🎲'] }
];

let emojiPickerBuilt = false;

function ensureEmojiPicker() {
  const p = document.getElementById('emoji-picker');
  if (!p || emojiPickerBuilt) return p;
  p.innerHTML = '';
  const tabs = document.createElement('div');
  tabs.className = 'emoji-tabs';
  const gridsWrap = document.createElement('div');
  gridsWrap.className = 'emoji-grids';
  EMOTE_CATALOG.forEach((cat, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'emoji-tab' + (i === 0 ? ' active' : '');
    tab.textContent = cat.name;
    tab.dataset.cat = cat.id;
    tabs.appendChild(tab);

    const grid = document.createElement('div');
    grid.className = 'emoji-grid' + (i === 0 ? ' active' : '');
    grid.dataset.cat = cat.id;
    cat.items.forEach((em) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-item';
      btn.textContent = em;
      btn.title = em;
      btn.addEventListener('click', () => sendEmoji(em));
      grid.appendChild(btn);
    });
    gridsWrap.appendChild(grid);
  });
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.emoji-tab');
    if (!tab) return;
    const id = tab.dataset.cat;
    tabs.querySelectorAll('.emoji-tab').forEach((t) => t.classList.toggle('active', t === tab));
    gridsWrap.querySelectorAll('.emoji-grid').forEach((g) => g.classList.toggle('active', g.dataset.cat === id));
  });
  p.appendChild(tabs);
  p.appendChild(gridsWrap);
  emojiPickerBuilt = true;
  return p;
}

function getBubbleAnchorEl(seatIndex) {
  const me = currentRoom?.players?.find((p) => p.id === mySocketId);
  if (me && Number(me.seatIndex) === Number(seatIndex)) {
    return document.querySelector('#hero-zone .hero-board') || document.getElementById('hero-zone');
  }
  return document.querySelector(`#seats-container .seat[data-seat="${seatIndex}"]`);
}

function showSeatBubble(seatIndex, content, opts = {}) {
  const layer = document.getElementById('seat-bubbles');
  const anchor = getBubbleAnchorEl(seatIndex);
  if (!layer || !anchor || content == null || content === '') return;

  const layerRect = layer.getBoundingClientRect();
  const aRect = anchor.getBoundingClientRect();
  if (!aRect.width && !aRect.height && aRect.top === 0 && aRect.left === 0) return;

  const kind = opts.kind === 'emoji' ? 'emoji' : 'text';
  const el = document.createElement('div');
  el.className = 'seat-bubble seat-bubble-' + kind;
  el.style.left = (aRect.left + aRect.width / 2 - layerRect.left) + 'px';
  el.style.top = (aRect.top - layerRect.top + (kind === 'emoji' ? aRect.height * 0.15 : -2)) + 'px';

  if (kind === 'emoji') {
    el.textContent = content;
  } else {
    const text = String(content).slice(0, 80);
    el.innerHTML = `<span class="seat-bubble-tail"></span><span class="seat-bubble-body">${escapeHtml(text)}</span>`;
  }

  layer.appendChild(el);
  const ttl = kind === 'emoji' ? 2800 : 3600;
  setTimeout(() => el.remove(), ttl);
}

function sendChat() {
  const input = document.getElementById('chat-input');
  if (input.value.trim()) {
    socket.emit('send-chat', input.value.trim());
    input.value = '';
  }
}

function toggleEmojiPicker() {
  const p = ensureEmojiPicker();
  if (!p) return;
  const open = p.hasAttribute('hidden') || p.style.display === 'none';
  if (open) {
    p.removeAttribute('hidden');
    p.style.display = 'flex';
  } else {
    p.setAttribute('hidden', '');
    p.style.display = 'none';
  }
}

function sendEmoji(emoji) {
  if (!emoji) return;
  socket.emit('emoji', emoji);
  const p = document.getElementById('emoji-picker');
  if (p) {
    p.setAttribute('hidden', '');
    p.style.display = 'none';
  }
}

// -------------------------
// HOST SETTINGS
// -------------------------
function openSettings() {
  if (!currentRoom || !amIHost()) {
    showToast('只有房主可以打开设置。', 3200);
    return;
  }
  document.getElementById('settings-modal').classList.add('show');
  updateSettingsUI();
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('show');
}

function updateSettingsUI() {
  if (!currentRoom) return;
  const kickSel = document.getElementById('kick-select');
  const chipSel = document.getElementById('editchips-select');
  const prevKick = kickSel.value;
  const prevChip = chipSel.value;
  kickSel.innerHTML = '';
  chipSel.innerHTML = '';
  currentRoom.players.forEach(p => {
    if (p.id !== mySocketId) {
      kickSel.innerHTML += `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}（玩家 $${p.chips}）</option>`;
    }
    chipSel.innerHTML += `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}（$${p.chips}）</option>`;
  });
  (currentRoom.spectators || []).forEach(s => {
    kickSel.innerHTML += `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}（观战）</option>`;
  });
  if (prevKick && [...kickSel.options].some(o => o.value === prevKick)) kickSel.value = prevKick;
  if (prevChip && [...chipSel.options].some(o => o.value === prevChip)) chipSel.value = prevChip;
  const maxInput = document.getElementById('settings-max-players');
  if (maxInput && !maxInput.value) maxInput.value = currentRoom.settings.maxPlayers;
  const rebuysStatus = document.getElementById('rebuys-status');
  if (rebuysStatus) {
    rebuysStatus.innerText = currentRoom.settings.rebuysAllowed ? '允许' : '关闭';
  }
  const approvalStatus = document.getElementById('rebuy-approval-status');
  if (approvalStatus) {
    approvalStatus.innerText = currentRoom.settings.rebuyNeedsApproval ? '需审核' : '免审';
  }
  const timerStatus = document.getElementById('timer-status');
  if (timerStatus) {
    timerStatus.innerText = currentRoom.settings.timerEnabled ? '开启' : '关闭';
  }
  const timerDurInput = document.getElementById('settings-timer-duration');
  if (timerDurInput && !timerDurInput.value) timerDurInput.value = currentRoom.settings.timerSeconds;

  const rebuyList = document.getElementById('rebuy-requests-list');
  if (rebuyList) {
    const requests = currentRoom.rebuyRequests || [];
    if (requests.length === 0) {
      rebuyList.innerHTML = '<p class="no-notifications">暂无申请</p>';
    } else {
      rebuyList.innerHTML = requests.map(r => `
        <div class="notification-card">
          <div class="notif-title">${escapeHtml(r.playerName)} 申请买入</div>
          <div class="notif-detail">申请金额：$${r.amount}</div>
          <div class="notif-actions">
            <input type="number" value="${r.amount}" id="rebuy-approve-amount-${escapeHtml(r.playerId)}" style="width:80px;">
            <button class="btn btn-secondary" onclick="approveRebuy('${escapeHtml(r.playerId)}', document.getElementById('rebuy-approve-amount-${escapeHtml(r.playerId)}').value)">批准</button>
            <button class="btn btn-danger" onclick="declineRebuy('${escapeHtml(r.playerId)}')">拒绝</button>
          </div>
        </div>
      `).join('');
    }
  }

  const joinList = document.getElementById('join-requests-list');
  if (joinList) {
    const requests = currentRoom.joinRequests || [];
    if (requests.length === 0) {
      joinList.innerHTML = '<p class="no-notifications">暂无申请</p>';
    } else {
      joinList.innerHTML = requests.map(r => `
        <div class="notification-card">
          <div class="notif-title">${escapeHtml(r.name)} 申请入座</div>
          <div class="notif-detail">${r.approved ? '已通过 — 下一手入座' : '待审批'}</div>
          ${!r.approved ? `
          <div class="notif-actions">
            <button class="btn btn-secondary" onclick="acceptJoin('${escapeHtml(r.spectatorId)}')">同意</button>
            <button class="btn btn-danger" onclick="declineJoin('${escapeHtml(r.spectatorId)}')">拒绝</button>
          </div>
          ` : ''}
        </div>
      `).join('');
    }
  }
}

function toggleTimer() {
  socket.emit('host-action', { type: 'toggle-timer' });
}

function changeTimerDuration() {
  const dur = document.getElementById('settings-timer-duration').value;
  if (!dur) return;
  socket.emit('host-action', { type: 'change-timer-duration', amount: dur });
}

async function kickPlayer() {
  const playerId = document.getElementById('kick-select').value;
  if (!playerId) return;
  const ok = await showConfirm('确定踢出？玩家会变观战，观战者会离开房间。', {
    danger: true,
    confirmText: '踢出'
  });
  if (!ok) return;
  socket.emit('host-action', { type: 'kick', playerId });
}

function editChips() {
  const playerId = document.getElementById('editchips-select').value;
  const amount = parseInt(document.getElementById('editchips-amount').value);
  if (!playerId) return showToast('请选择玩家', 2800, 'error');
  if (isNaN(amount) || amount < 0) return showToast('请输入有效筹码', 2800, 'error');
  socket.emit('host-action', { type: 'edit-chips', playerId, amount });
  document.getElementById('editchips-amount').value = '';
}

function changePassword() {
  const pw = document.getElementById('new-password').value;
  socket.emit('host-action', { type: 'change-password', password: pw });
  document.getElementById('new-password').value = '';
  showToast('密码已更新');
}

function toggleRebuys() {
  socket.emit('host-action', { type: 'toggle-rebuys' });
}

function changeMaxPlayers() {
  const amount = parseInt(document.getElementById('settings-max-players').value);
  if (!amount) return;
  if (amount < 2) return showToast('人数至少 2 人', 2800, 'error');
  if (amount > 12) return showToast('最多 12 人', 2800, 'error');
  socket.emit('host-action', { type: 'change-max-players', amount });
}

// -------------------------
// MISC
// -------------------------
async function copyCode() {
  if (!currentRoom) return;
  const invite = getInviteUrl(currentRoom.id);
  const text = `来打德州！房间号 ${currentRoom.id}\n${invite}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast('邀请链接已复制');
  } catch (_) {
    // 旧浏览器 / 非 HTTPS：选中临时输入框
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('邀请链接已复制');
    } catch (e) {
      prompt('复制以下邀请信息发给好友：', text);
    }
    ta.remove();
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  const label = document.getElementById('sound-btn-label');
  if (label) label.textContent = soundEnabled ? '🔊 音效' : '🔇 音效（关）';
  const btn = document.getElementById('sound-btn');
  if (btn) btn.style.opacity = soundEnabled ? '1' : '0.65';
  const topBtn = document.getElementById('btn-sound-top');
  if (topBtn) {
    topBtn.textContent = soundEnabled ? '🔊' : '🔇';
    topBtn.style.opacity = soundEnabled ? '1' : '0.65';
    topBtn.setAttribute('aria-pressed', soundEnabled ? 'false' : 'true');
  }
}

function toggleChat() {
  const el = document.getElementById('chat-container');
  if (!el) return;
  el.classList.toggle('active');
  if (el.classList.contains('active')) clearChatBadge();
}

function toggleTopMenu(event) {
  event?.stopPropagation?.();
  const menu = document.getElementById('top-menu');
  const btn = document.getElementById('top-menu-btn');
  if (!menu) return;
  const open = !menu.classList.contains('open');
  menu.classList.toggle('open', open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeTopMenu() {
  const menu = document.getElementById('top-menu');
  const btn = document.getElementById('top-menu-btn');
  menu?.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function menuAction(fn) {
  closeTopMenu();
  if (typeof fn === 'function') fn();
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('top-menu');
  if (!menu?.classList.contains('open')) return;
  if (!menu.contains(e.target)) closeTopMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTopMenu();
});

window.addEventListener('resize', () => { if (currentRoom) renderTable(); });

// 由 App 在登录后调用 connectGameSocket；邀请码交给大厅处理
window.GameClient = {
  connectGameSocket,
  createRoom,
  joinRoomByCode,
  spectateRoomByCode,
  leaveRoom,
  pendingInvite,
  get socket() { return socket; },
  get currentRoom() { return currentRoom; }
};