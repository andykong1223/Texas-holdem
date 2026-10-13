const socket = io({ autoConnect: false });
let currentRoom = null;
let mySocketId = null;
let isSpectator = false;
let soundEnabled = true;
let audioCtx = null;
let timerInterval = null;
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

function showToast(msg, ms = 2200) {
  const toast = document.getElementById('toast');
  if (!toast) {
    alert(msg);
    return;
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('show'), ms);
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
  if (!maxPlayersRaw || maxPlayersRaw < 2) return alert('人数至少 2 人');
  if (maxPlayersRaw > 12) return alert('最多 12 人');
  if (!socket.connected) return alert('未连接，请先登录');

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
  if (!code) return alert('请输入房间号');
  if (!socket.connected) return alert('未连接，请先登录');
  socket.emit('join-room', { roomCode: code, password });
  closeJoinModal();
}

function spectateFromModal() {
  const code = document.getElementById('join-modal-code').value.trim().toUpperCase();
  const password = document.getElementById('join-modal-password').value;
  if (!code) return alert('请输入房间号');
  if (!socket.connected) return alert('未连接，请先登录');
  socket.emit('spectate-room', { roomCode: code, password });
  closeJoinModal();
}

function joinRoomDirect() {
  const code = (document.getElementById('join-code')?.value || '').trim().toUpperCase();
  const password = document.getElementById('join-password')?.value || '';
  if (!code) return alert('请输入房间号');
  if (!socket.connected) return alert('未连接，请先登录');
  socket.emit('join-room', { roomCode: code, password });
}

function spectateDirect() {
  const code = (document.getElementById('join-code')?.value || '').trim().toUpperCase();
  const password = document.getElementById('join-password')?.value || '';
  if (!code) return alert('请输入房间号');
  if (!socket.connected) return alert('未连接，请先登录');
  socket.emit('spectate-room', { roomCode: code, password });
}

function joinRoomByCode(code, password = '') {
  if (!socket.connected) return alert('未连接，请先登录');
  socket.emit('join-room', { roomCode: String(code || '').toUpperCase(), password });
}

function spectateRoomByCode(code, password = '') {
  if (!socket.connected) return alert('未连接，请先登录');
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

socket.on('joined-as-player', () => {
  isSpectator = false;
  hasRequestedJoin = false;
  updateSpectatorUI();
});

socket.on('join-requested', (val) => {
  hasRequestedJoin = val;
  updateSpectatorUI();
});

socket.on('join-status', (data) => {
  if (data.status === 'approved') {
    alert('入座申请已通过，下一手开始时入座。');
  } else if (data.status === 'declined') {
    alert('入座申请被拒绝。');
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
    alert(`买入已批准 $${data.amount}，下一手入局。`);
  } else {
    alert('买入申请被拒绝。');
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
    alert('牌局已结算');
    if (window.App) window.App.showLobby();
  }
});

socket.on('error-msg', (msg) => alert(msg));

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
  if (data.results.some(r => r.playerId === mySocketId)) playSound('win');
  else playSound('fold');
  const banner = document.getElementById('win-banner');
  if (banner) {
    banner.innerText = data.results.map(r => {
      const p = currentRoom.players.find(pl => pl.id === r.playerId);
      const handZh = HAND_NAME_ZH[r.hand] || r.hand;
      return `${p?.name || ''} 赢 $${r.amount}（${handZh}）`;
    }).join('  ·  ');
    banner.classList.add('show');
    clearTimeout(banner._timer);
    banner._timer = setTimeout(() => {
      banner.classList.remove('show');
      banner.innerText = '';
    }, 2500);
  }
  // 下一手立即开始，不展示倒计时遮罩
  document.getElementById('next-hand-overlay')?.classList.add('hidden');
  // 若历史弹窗开着，刷新到最新一手
  if (document.getElementById('hand-history-modal')?.classList.contains('show')) {
    requestHandHistory('latest');
  }
});

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
});

socket.on('emoji-received', (data) => {
  const seat = document.querySelector(`.seat[data-seat="${data.seatIndex}"]`);
  if (seat) {
    const emoji = document.createElement('div');
    emoji.className = 'floating-emoji';
    emoji.innerText = data.emoji;
    emoji.style.left = '50%';
    emoji.style.top = '0';
    seat.appendChild(emoji);
    setTimeout(() => emoji.remove(), 2000);
  }
});

socket.on('kicked', (data) => {
  if (data && data.toSpectator) {
    alert('房主已将你移至观战。');
    isSpectator = true;
    hasRequestedJoin = false;
    rebuyPending = false;
    updateSpectatorUI();
  } else {
    alert('你已被房主移出房间。');
    leaveRoom();
  }
});

// -------------------------
// TIMER COUNTDOWN
// -------------------------
function startTimerCountdown(endTime, isMyTurn = false) {
  const bar = document.getElementById('timer-bar');
  const text = document.getElementById('timer-text');
  const row = document.getElementById('timer-row');
  const extendBtn = document.getElementById('btn-extend-timer');
  if (!endTime || endTime === 0) {
    row?.classList.remove('show');
    extendBtn?.classList.remove('show');
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    return;
  }
  row?.classList.add('show');
  if (extendBtn) extendBtn.classList.toggle('show', !!isMyTurn);
  if (timerInterval) clearInterval(timerInterval);
  const initialLeft = Math.max(0.1, (endTime - Date.now()) / 1000);
  const update = () => {
    const timeLeft = Math.max(0, (endTime - Date.now()) / 1000);
    const pct = (timeLeft / initialLeft) * 100;
    bar.style.width = pct + '%';
    text.innerText = Math.ceil(timeLeft) + 's';
    if (timeLeft < 5) {
      bar.style.background = 'var(--btn-danger)';
      const wholeSec = Math.ceil(timeLeft);
      if (timeLeft > 0 && wholeSec !== update._lastTick) {
        update._lastTick = wholeSec;
        playSound('tick');
      }
    } else {
      bar.style.background = 'var(--btn-secondary)';
    }
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      row?.classList.remove('show');
      extendBtn?.classList.remove('show');
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
  if (!amount || amount < 1) return alert('请输入有效金额');
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
  if (!numAmount || numAmount < 1) return alert('Invalid amount');
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

function endGame() {
  if (!confirm('确定解散房间？所有人将返回大厅。')) return;
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
    alert('观战中无法买入，请先入座');
    return;
  }
  if (!currentRoom.settings?.rebuysAllowed) {
    alert('本桌已关闭买入');
    return;
  }
  if (rebuyPending) {
    alert('已有买入申请等待确认');
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
    else if (p.isSittingOut) status = '(旁观)';
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
  const isRed = RED_SUITS[c.s];
  return `<div class="card ${isRed ? 'red' : ''} ${extraClass}"><div class="card-rank">${displayRank(c.r)}</div><div class="card-suit">${SUIT_SYMBOLS[c.s]}</div></div>`;
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
  'High Card': '高牌',
  'Win by Fold': '无人跟注获胜',
  'Uncontested Side Pot': '边池'
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

function setRaisePreset(frac) {
  if (!currentRoom) return;
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me) return;
  const pot = getTotalPot() || currentRoom.settings.bigBlind * 2;
  const minRaise = getMinRaiseTotal();
  const toCall = Math.max(0, currentRoom.gameState.currentBet - (me.currentBet || 0));
  // 目标：当前已投入 + 跟注后的加注额 ≈ 底池比例（相对底池加注）
  let target = Math.max(minRaise, currentRoom.gameState.currentBet + Math.round(pot * frac));
  target = Math.min(target, (me.currentBet || 0) + me.chips);
  if (target < minRaise) target = Math.min(minRaise, (me.currentBet || 0) + me.chips);
  document.getElementById('raise-amount').value = target;
  syncRaiseSlider();
  // 若只是跟注级别且 frac 很小，仍填最低加注
  void toCall;
}

function syncRaiseSlider() {
  const amountEl = document.getElementById('raise-amount');
  const slider = document.getElementById('raise-slider');
  if (!currentRoom || !amountEl || !slider) return;
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me) return;
  const minRaise = getMinRaiseTotal();
  const maxRaise = (me.currentBet || 0) + me.chips;
  const val = parseInt(amountEl.value) || minRaise;
  const span = Math.max(1, maxRaise - minRaise);
  slider.min = 0;
  slider.max = 100;
  slider.value = Math.round(((Math.min(Math.max(val, minRaise), maxRaise) - minRaise) / span) * 100);
}

function onRaiseSlider() {
  if (!currentRoom) return;
  const me = currentRoom.players.find(p => p.id === mySocketId);
  if (!me) return;
  const minRaise = getMinRaiseTotal();
  const maxRaise = (me.currentBet || 0) + me.chips;
  const pct = parseInt(document.getElementById('raise-slider').value) || 0;
  const amount = Math.round(minRaise + (maxRaise - minRaise) * (pct / 100));
  document.getElementById('raise-amount').value = amount;
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
  return (cards || []).map(c => `${c.r}${c.s}`).join('|');
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
  const seatHalfW = isMobileLayout ? 34 : 43;
  const seatHalfH = isMobileLayout ? 46 : 54;
  const layoutKey = `${Math.round(tableWidth)}x${Math.round(tableHeight)}:${maxPlayers}:${anchorSeat}:${isMobileLayout ? 1 : 0}:stad-even`;
  const layoutChanged = seatsContainer.dataset.layoutKey !== layoutKey;
  if (layoutChanged) {
    seatsContainer.dataset.layoutKey = layoutKey;
    seatsContainer.innerHTML = '';
  }

  for (let seatIdx = 0; seatIdx < maxPlayers; seatIdx++) {
    // 相对自己旋转：自己在底边中点，其余沿桌边等弧长均匀分布
    const relIndex = ((seatIdx - anchorSeat) % maxPlayers + maxPlayers) % maxPlayers;
    const t = relIndex / maxPlayers;
    const pt = stadiumSeatPoint(t, tableWidth, tableHeight, isMobileLayout ? 0.12 : 0.09);
    const x = pt.x;
    const y = pt.y;
    // 注额往桌心偏一点（沿法向反方向）
    const betOffX = Math.round(-(pt.nx || 0) * 26);
    const betOffY = Math.round(-(pt.ny || 0) * 22);

    let seat = seatsContainer.querySelector(`.seat[data-seat="${seatIdx}"]`);
    if (!seat) {
      seat = document.createElement('div');
      seat.dataset.seat = seatIdx;
      seatsContainer.appendChild(seat);
    }
    const p = seatMap[seatIdx];
    // 自己的座位略往桌心收，避免名字/头像压到底部手牌上
    const isMeSeat = p && p.id === mySocketId;
    const nudgeY = isMeSeat ? -Math.round(seatHalfH * 0.35) : 0;
    // 右侧座位手牌放头像左侧，避免贴出屏幕
    const cardsOnLeft = x >= tableWidth * 0.5;
    seat.style.left = (x - seatHalfW) + 'px';
    seat.style.top = (y - seatHalfH + nudgeY) + 'px';

    if (!p) {
      const emptyKey = 'empty';
      if (seat.dataset.renderKey !== emptyKey) {
        seat.dataset.renderKey = emptyKey;
        seat.className = 'seat empty';
        seat.innerHTML = `
          <div class="seat-avatar-wrap">
            <div class="seat-avatar" style="background:#1a2a22;border-style:dashed;">+</div>
          </div>
          <div class="seat-info"><div class="seat-name">空位</div><div class="seat-chips">&nbsp;</div></div>
        `;
      }
      seat.classList.toggle('cards-left', cardsOnLeft);
      continue;
    }

    const isShowdown = currentRoom.gameState.status === 'playing'
      && currentRoom.gameState.bettingRound === 'showdown';
    const showHoleFaceUp = !!(p.holeCards && p.holeCards.length > 0 && !p.folded);
    const cardsRevealed = isShowdown && showHoleFaceUp;
    const isActive = currentRoom.gameState.currentPlayerIndex === p.seatIndex
      && !p.folded
      && !p.disconnected
      && currentRoom.gameState.status === 'playing'
      && currentRoom.gameState.bettingRound !== 'showdown';
    const pos = positionMap[p.seatIndex];
    const renderKey = [
      p.id, p.chips, p.currentBet, p.folded, p.allIn, p.disconnected, p.isSittingOut,
      isActive, cardsRevealed, cardsSignature(p.holeCards), pos?.code || '',
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
      if (showHoleFaceUp) {
        p.holeCards.forEach(c => { cardsHtml += cardHtml(c); });
      } else if (!p.folded && !p.disconnected && currentRoom.gameState.status === 'playing' && !isShowdown) {
        cardsHtml += '<div class="card card-back"></div><div class="card card-back"></div>';
      }
    } else if (cardsRevealed) {
      p.holeCards.forEach(c => { cardsHtml += cardHtml(c); });
    }
    cardsHtml += '</div>';

    let statusTag = '';
    if (p.disconnected) statusTag = '<div class="seat-status-tag">暂离</div>';
    else if (p.allIn) statusTag = '<div class="seat-status-tag">全下</div>';
    else if (p.folded) statusTag = '<div class="seat-status-tag">弃牌</div>';

    const posClass = pos ? `pos-${(pos.code || '').toLowerCase().replace('+', 'p')}` : '';
    const posHtml = pos
      ? `<div class="seat-position ${posClass}" title="${escapeHtml(pos.code)}">${escapeHtml(pos.name)}</div>`
      : '';
    const showDealerChip = currentRoom.gameState.dealerIndex === p.seatIndex
      || !!pos?.isDealer;

    seat.innerHTML = `
      ${statusTag}
      <div class="seat-avatar-wrap">
        ${posHtml}
        <div class="seat-timer-ring"></div>
        <div class="seat-avatar" style="background:${avatarColor(p.name)}">${escapeHtml(avatarInitials(p.name))}</div>
        ${showDealerChip ? '<div class="dealer-button">D</div>' : ''}
        ${cardsHtml}
      </div>
      <div class="seat-info">
        <div class="seat-name">${escapeHtml(p.name)}${p.id === mySocketId ? ' ·我' : ''}${p.disconnected ? ' ·暂离' : ''}</div>
        <div class="seat-chips">${formatChips(p.chips)}</div>
      </div>
      ${p.currentBet > 0 ? `<div class="seat-bet" style="left:calc(50% + ${betOffX}px); top:calc(50% + ${betOffY}px); transform:translate(-50%,-50%); bottom:auto;">${formatChips(p.currentBet)}</div>` : ''}
    `;
  }

  // 公共牌 + 底池（内容未变则不重绘）
  updateCommunityCardsDom();
  const totalPot = getTotalPot();
  const potDiv = document.getElementById('pot-display');
  const potText = totalPot > 0 || currentRoom.gameState.status === 'playing'
    ? `底池 ${formatChips(totalPot)}`
    : '';
  if (potDiv.textContent !== potText) potDiv.textContent = potText;

  // 自己的大牌（底部 hero）+ 当前牌型
  const me = currentRoom.players.find(p => p.id === mySocketId);
  updateHeroCardsDom(me);
  updateHeroHandRank(me);

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
        if (p.hasRebought) return true;
        return !p.isSittingOut && p.chips > 0;
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
  const betPresets = document.getElementById('bet-presets');
  const raiseRow = document.getElementById('raise-slider-row');
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

  // 开局后固定行动区高度，避免轮到你时牌桌忽大忽小
  if (actionBar) actionBar.classList.toggle('in-hand', !isWaitingLobby);

  if (waitingActions) waitingActions.classList.toggle('show', isWaitingLobby);
  if (actionsRow) actionsRow.style.display = isWaitingLobby ? 'none' : 'grid';

  if (isMyTurn) {
    turnIndicator.classList.remove('hidden');
    actionStatus.innerText = '';
    betPresets.classList.add('show');
    raiseRow.classList.add('show');
  } else {
    turnIndicator.classList.add('hidden');
    betPresets.classList.remove('show');
    raiseRow.classList.remove('show');
    if (currentRoom.gameState.status === 'playing' && currentRoom.gameState.bettingRound !== 'showdown') {
      const currentPlayer = currentRoom.players.find(p => p.seatIndex === currentRoom.gameState.currentPlayerIndex);
      actionStatus.innerText = currentPlayer ? `等待 ${currentPlayer.name} 行动…` : '';
    } else if (currentRoom.gameState.bettingRound === 'showdown') {
      actionStatus.innerText = '本手结束 — 等待房主开下一手…';
    } else if (isWaitingLobby) {
      actionStatus.innerText = '分享房间号，喊朋友上车';
    } else {
      actionStatus.innerText = '';
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
  btnAllin.disabled = disableActions;

  btnCheck.classList.toggle('hidden-btn', !canCheck);
  btnCall.classList.toggle('hidden-btn', canCheck);

  btnCall.innerText = actualCall > 0 ? `跟注 ${formatChips(actualCall)}` : '跟注';
  btnCheck.innerText = '过牌';
  btnRaise.innerText = (currentRoom.gameState.currentBet || 0) > 0 ? '加注' : '下注';

  if (isMyTurn) {
    const minRaise = getMinRaiseTotal();
    const amountEl = document.getElementById('raise-amount');
    amountEl.min = minRaise;
    amountEl.placeholder = `${minRaise}`;
    if (!amountEl.value || parseInt(amountEl.value) < minRaise) {
      amountEl.value = Math.min(minRaise, (me.currentBet || 0) + me.chips);
    }
    syncRaiseSlider();
  }

  if (currentRoom.gameState.timerEnd && currentRoom.gameState.status === 'playing' && currentRoom.settings.timerEnabled) {
    const endTime = currentRoom.gameState.timerEnd;
    if (endTime > Date.now()) {
      startTimerCountdown(endTime, isMyTurn);
    }
  } else {
    document.getElementById('timer-row')?.classList.remove('show');
    document.getElementById('btn-extend-timer')?.classList.remove('show');
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
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
  const amount = parseInt(document.getElementById('raise-amount').value);
  if (!amount) return alert('请输入加注金额');
  socket.emit('action', { action: 'raise', amount });
  playSound('click');
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
// CHAT
// -------------------------
function sendChat() {
  const input = document.getElementById('chat-input');
  if (input.value.trim()) {
    socket.emit('send-chat', input.value.trim());
    input.value = '';
  }
}

function toggleEmojiPicker() {
  const p = document.getElementById('emoji-picker');
  p.style.display = p.style.display === 'none' ? 'grid' : 'none';
}

function sendEmoji(emoji) {
  socket.emit('emoji', emoji);
  document.getElementById('emoji-picker').style.display = 'none';
}

// -------------------------
// HOST SETTINGS
// -------------------------
function openSettings() {
  if (!currentRoom || !amIHost()) {
    alert('只有房主可以打开设置。');
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

function kickPlayer() {
  const playerId = document.getElementById('kick-select').value;
  if (!playerId) return;
  if (!confirm('确定踢出？玩家会变观战，观战者会离开房间。')) return;
  socket.emit('host-action', { type: 'kick', playerId });
}

function editChips() {
  const playerId = document.getElementById('editchips-select').value;
  const amount = parseInt(document.getElementById('editchips-amount').value);
  if (!playerId) return alert('请选择玩家');
  if (isNaN(amount) || amount < 0) return alert('请输入有效筹码');
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
  if (amount < 2) return alert('人数至少 2 人');
  if (amount > 12) return alert('最多 12 人');
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
}

function toggleChat() {
  document.getElementById('chat-container').classList.toggle('active');
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