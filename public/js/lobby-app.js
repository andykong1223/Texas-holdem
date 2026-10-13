const App = {
  user: null,
  lobbyTimer: null,
  currentTab: 'home',

  async init() {
    this.bindAuthForms();
    this.bindLobby();
    this.bindTabs();
    this.bindProfile();
    const token = API.getToken();
    if (!token) {
      this.showAuth();
      return;
    }
    try {
      const { user } = await API.me();
      this.onLoginSuccess(API.getToken(), user, { skipConnect: false });
      if (window.GameClient?.pendingInvite) {
        document.getElementById('lobby-join-code').value = window.GameClient.pendingInvite;
        this.toast(`收到邀请房间 ${window.GameClient.pendingInvite}`);
      }
    } catch (_) {
      API.clearSession();
      this.showAuth();
    }
  },

  bindAuthForms() {
    document.getElementById('tab-login')?.addEventListener('click', () => this.switchAuthTab('login'));
    document.getElementById('tab-register')?.addEventListener('click', () => this.switchAuthTab('register'));
    document.getElementById('form-login')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      try {
        const data = await API.login({ username, password });
        this.onLoginSuccess(data.token, data.user);
      } catch (err) {
        this.toast(err.message);
      }
    });
    document.getElementById('form-register')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('reg-username').value.trim();
      const nickname = document.getElementById('reg-nickname').value.trim();
      const password = document.getElementById('reg-password').value;
      try {
        const data = await API.register({ username, nickname, password });
        this.onLoginSuccess(data.token, data.user);
      } catch (err) {
        this.toast(err.message);
      }
    });
  },

  switchAuthTab(whichtab) {
    const login = whichtab === 'login';
    document.getElementById('tab-login')?.classList.toggle('active', login);
    document.getElementById('tab-register')?.classList.toggle('active', !login);
    document.getElementById('form-login').style.display = login ? 'block' : 'none';
    document.getElementById('form-register').style.display = login ? 'none' : 'block';
  },

  onLoginSuccess(token, user, { skipConnect = false } = {}) {
    API.setSession(token, user);
    this.user = user;
    this.renderUserChrome();
    if (!skipConnect && window.GameClient) {
      window.GameClient.connectGameSocket(token);
    }
    this.showLobby();
  },

  onAuthRequired(msg) {
    this.toast(msg || '请先登录');
    API.clearSession();
    this.user = null;
    if (window.GameClient?.socket?.connected) window.GameClient.socket.disconnect();
    this.showAuth();
  },

  onWalletUpdate(partial) {
    if (!this.user) return;
    if (typeof partial.chips === 'number') this.user.chips = partial.chips;
    if (partial.nickname) this.user.nickname = partial.nickname;
    API.setSession(API.getToken(), this.user);
    this.renderUserChrome();
  },

  renderUserChrome() {
    const u = this.user;
    document.querySelectorAll('[data-user-nick]').forEach(el => {
      el.textContent = u?.nickname || '—';
    });
    document.querySelectorAll('[data-user-chips]').forEach(el => {
      el.textContent = u ? String(u.chips) : '0';
    });
    document.querySelectorAll('[data-admin-only]').forEach(el => {
      el.style.display = u?.role === 'admin' ? '' : 'none';
    });
  },

  showAuth() {
    this.stopLobbyPolling();
    this.showOnly('screen-auth');
  },

  showLobby() {
    this.showMain(this.currentTab || 'home');
  },

  showMain(tab = 'home') {
    this.showOnly('screen-main');
    this.switchTab(tab);
    this.startLobbyPolling();
  },

  showProfile() {
    this.showMain('profile');
  },

  showHost() {
    this.stopLobbyPolling();
    this.showOnly('screen-host');
  },

  showGame() {
    this.stopLobbyPolling();
    this.showOnly('screen-game');
  },

  showSettlement(payload) {
    this.stopLobbyPolling();
    this.showOnly('screen-settlement');
    document.getElementById('settle-reason').textContent = payload?.reasonText || '本场已结束';
    document.getElementById('settle-meta').textContent =
      `${payload?.roomName || ''} · 共 ${payload?.handNumber || 0} 手`;
    const tbody = document.getElementById('settle-tbody');
    const myId = this.user?.id;
    const results = payload?.results || [];
    if (!results.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#8a968e;">暂无结算数据</td></tr>';
    } else {
      tbody.innerHTML = results.map((r, i) => {
        const profitCls = r.profit > 0 ? 'profit-up' : (r.profit < 0 ? 'profit-down' : '');
        const profitText = (r.profit > 0 ? '+' : '') + r.profit;
        const isMe = myId && r.userId === myId;
        return `<tr class="${isMe ? 'me' : ''}">
          <td>${i + 1}</td>
          <td>${escapeHtml(r.name)}${isMe ? ' ·我' : ''}</td>
          <td>${r.buyIn}</td>
          <td>${r.cashOut}</td>
          <td class="${profitCls}">${profitText}</td>
        </tr>`;
      }).join('');
    }
    API.me().then(({ user }) => {
      this.user = user;
      API.setSession(API.getToken(), user);
      this.renderUserChrome();
    }).catch(() => {});
  },

  showOnly(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
  },

  async leaveGame() {
    try {
      const { user } = await API.me();
      this.user = user;
      API.setSession(API.getToken(), user);
      this.renderUserChrome();
    } catch (_) {}
    if (API.getToken() && window.GameClient && !window.GameClient.socket?.connected) {
      window.GameClient.connectGameSocket(API.getToken());
    }
    this.showMain('home');
  },

  bindTabs() {
    document.querySelectorAll('#bottom-tabbar .tab-item').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
    document.querySelectorAll('[data-goto-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.getAttribute('data-goto-tab')));
    });
  },

  switchTab(tab) {
    if (!tab) tab = 'home';
    this.currentTab = tab;
    document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
    document.getElementById(`tab-${tab}`)?.classList.add('active');
    document.querySelectorAll('#bottom-tabbar .tab-item').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });

    if (tab === 'home') this.refreshLobby();
    if (tab === 'games') this.loadSessions();
    if (tab === 'players') this.loadPlayers();
    if (tab === 'profile') this.loadProfile();
  },

  bindLobby() {
    document.getElementById('btn-refresh-lobby')?.addEventListener('click', () => this.refreshLobby());
    document.getElementById('btn-goto-create')?.addEventListener('click', () => this.showHost());
    document.getElementById('btn-games-create')?.addEventListener('click', () => this.showHost());
    document.getElementById('btn-settle-lobby')?.addEventListener('click', () => this.leaveGame());
    document.getElementById('btn-logout')?.addEventListener('click', () => {
      API.clearSession();
      if (window.GameClient?.socket?.connected) window.GameClient.socket.disconnect();
      this.user = null;
      this.showAuth();
    });
    document.getElementById('btn-lobby-join')?.addEventListener('click', () => {
      const code = document.getElementById('lobby-join-code').value.trim().toUpperCase();
      const password = document.getElementById('lobby-join-password').value;
      if (!code) return this.toast('请输入房间号');
      window.GameClient.joinRoomByCode(code, password);
    });
    document.getElementById('btn-lobby-spectate')?.addEventListener('click', () => {
      const code = document.getElementById('lobby-join-code').value.trim().toUpperCase();
      const password = document.getElementById('lobby-join-password').value;
      if (!code) return this.toast('请输入房间号');
      window.GameClient.spectateRoomByCode(code, password);
    });
    document.getElementById('btn-host-back')?.addEventListener('click', () => this.showMain('home'));
    document.getElementById('btn-close-session-detail')?.addEventListener('click', () => {
      document.getElementById('session-detail-modal')?.classList.remove('show');
    });
    document.getElementById('btn-close-player-detail')?.addEventListener('click', () => {
      document.getElementById('player-detail-modal')?.classList.remove('show');
    });
  },

  hudItems(hud) {
    const L = hud?.labels || {};
    return [
      { key: 'VPIP', val: L.vpip || '—' },
      { key: 'PFR', val: L.pfr || '—' },
      { key: '3-Bet', val: L.threeBet || '—' },
      { key: 'C-Bet', val: L.cbet || '—' },
      { key: 'Fold Cbet', val: L.foldToCbet || '—' },
      { key: 'WTSD', val: L.wtsd || '—' },
      { key: 'W$SD', val: L.wsd || '—' },
      { key: 'AF', val: L.af || '—' }
    ];
  },

  renderHudGrid(elOrId, hud) {
    const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
    if (!el) return;
    const items = this.hudItems(hud);
    el.innerHTML = items.map(it => `
      <div class="hud-cell">
        <div class="hud-val">${escapeHtml(it.val)}</div>
        <div class="hud-label">${escapeHtml(it.key)}</div>
      </div>
    `).join('');
  },

  startLobbyPolling() {
    this.stopLobbyPolling();
    this.lobbyTimer = setInterval(() => {
      if (this.currentTab === 'home') this.refreshLobby();
    }, 5000);
  },

  stopLobbyPolling() {
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);
    this.lobbyTimer = null;
  },

  async refreshLobby() {
    try {
      const [{ rooms }, { items }] = await Promise.all([
        API.lobbyRooms(),
        API.listSessions(8)
      ]);
      this.renderRooms(rooms || []);
      this.renderSessionList('home-recent-sessions', items || [], { empty: '暂无已结算牌局' });
    } catch (err) {
      if (String(err.message).includes('登录')) this.onAuthRequired(err.message);
    }
  },

  async loadSessions() {
    try {
      const { items } = await API.listSessions(50);
      this.renderSessionList('games-session-list', items || [], { empty: '暂无牌局记录<br>创建并结算后会出现在这里' });
    } catch (err) {
      this.toast(err.message);
    }
  },

  async loadPlayers() {
    try {
      const { items } = await API.playerStats(50);
      this.renderPlayerStats(items || []);
    } catch (err) {
      this.toast(err.message);
    }
  },

  renderRooms(rooms) {
    const el = document.getElementById('lobby-room-list');
    if (!el) return;
    if (!rooms.length) {
      el.innerHTML = '<div class="empty-state small">暂无进行中的牌局<br>点击上方「创建牌桌」开一桌</div>';
      return;
    }
    el.innerHTML = rooms.map(r => `
      <div class="room-card ${r.isPlaying ? 'playing' : 'waiting'}">
        <div class="room-card-main">
          <div class="room-card-title">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="badge ${r.isPlaying ? 'badge-live' : 'badge-wait'}">${r.isPlaying ? '进行中' : '等待中'}</span>
            ${r.hasPassword ? '<span class="badge badge-lock">密码锁</span>' : ''}
          </div>
          <div class="room-card-meta">
            房间 ${escapeHtml(r.id)} · 盲注 ${r.smallBlind}/${r.bigBlind} · 买入 ${r.buyIn}
            · ${r.sessionMinutes ? formatLobbySession(r.sessionMinutes) : '不限时'}
          </div>
          <div class="room-card-meta">
            房主 ${escapeHtml(r.hostName)} · ${r.playerCount}/${r.maxPlayers} 人
            ${r.handNumber ? ` · 第 ${r.handNumber} 手` : ''}
          </div>
        </div>
        <div class="room-card-actions">
          <button class="btn btn-primary btn-sm" data-join="${escapeHtml(r.id)}" data-lock="${r.hasPassword ? '1' : '0'}">加入</button>
          <button class="btn btn-tertiary btn-sm" data-spec="${escapeHtml(r.id)}" data-lock="${r.hasPassword ? '1' : '0'}">观战</button>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('[data-join]').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-join');
        let password = '';
        if (btn.getAttribute('data-lock') === '1') {
          password = prompt('请输入房间密码') || '';
        }
        window.GameClient.joinRoomByCode(code, password);
      });
    });
    el.querySelectorAll('[data-spec]').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-spec');
        let password = '';
        if (btn.getAttribute('data-lock') === '1') {
          password = prompt('请输入房间密码') || '';
        }
        window.GameClient.spectateRoomByCode(code, password);
      });
    });
  },

  renderSessionList(elId, items, { empty } = {}) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!items.length) {
      el.innerHTML = `<div class="empty-state small">${empty || '暂无记录'}</div>`;
      return;
    }
    el.innerHTML = items.map(s => `
      <button type="button" class="session-card" data-session-id="${s.id}">
        <div class="session-card-top">
          <span class="session-card-title">${escapeHtml(s.roomName || s.roomCode)}</span>
          <span class="badge badge-wait">已结算</span>
        </div>
        <div class="session-card-meta">
          ${escapeHtml(s.blinds || '')} · ${s.playerCount || 0} 人 · 买入合计 ${s.totalBuyIn || 0}
          · ${s.handsPlayed || 0} 手
        </div>
        <div class="session-card-meta">${escapeHtml(s.endedAt || s.startedAt || '')}</div>
      </button>
    `).join('');

    el.querySelectorAll('[data-session-id]').forEach(btn => {
      btn.addEventListener('click', () => this.openSessionDetail(btn.getAttribute('data-session-id')));
    });
  },

  async openSessionDetail(id) {
    try {
      const { session } = await API.sessionDetail(id);
      const modal = document.getElementById('session-detail-modal');
      document.getElementById('session-detail-title').textContent = session.roomName || session.roomCode;
      document.getElementById('session-detail-meta').textContent =
        `${session.blinds} · ${session.endedAt || session.startedAt || ''} · 房间 ${session.roomCode}`;
      const body = document.getElementById('session-detail-body');
      const results = session.results || [];
      if (!results.length) {
        body.innerHTML = '<div class="empty-state small">暂无结算明细</div>';
      } else {
        body.innerHTML = results.map((r, i) => {
          const profit = r.profit || 0;
          const cls = profit > 0 ? 'profit-up' : (profit < 0 ? 'profit-down' : '');
          const text = (profit > 0 ? '+' : '') + profit;
          const buy = r.buyIn != null ? `买入 ${r.buyIn} → 带出 ${r.cashOut}` : `${r.handsPlayed || 0} 手`;
          return `<div class="session-detail-row">
            <div>
              <b>${i + 1}. ${escapeHtml(r.name)}</b>
              <div class="session-card-meta">${buy}</div>
            </div>
            <span class="${cls}">${text}</span>
          </div>`;
        }).join('');
      }
      modal?.classList.add('show');
    } catch (err) {
      this.toast(err.message);
    }
  },

  renderPlayerStats(items) {
    const el = document.getElementById('players-stats-list');
    if (!el) return;
    if (!items.length) {
      el.innerHTML = '<div class="empty-state small">暂无玩家战绩<br>结算整场牌局后会出现排名</div>';
      return;
    }
    el.innerHTML = items.map((p, i) => {
      const profit = p.profit || 0;
      const cls = profit > 0 ? 'profit-up' : (profit < 0 ? 'profit-down' : '');
      const text = (profit > 0 ? '+' : '') + profit;
      const rate = Math.min(100, Math.round((p.winRate || 0) * 100));
      return `<button type="button" class="player-stat-card" data-player-id="${p.userId}">
        <div class="player-stat-top">
          <div style="display:flex;align-items:center;min-width:0;">
            <span class="player-rank">${i + 1}</span>
            <span class="player-stat-name">${escapeHtml(p.nickname)}</span>
          </div>
          <span class="${cls}">${text}</span>
        </div>
        <div class="player-stat-meta">
          ${p.sessions || 0} 局 · 盈利局 ${p.wins || 0}（${rate}%）· 手数 ${p.handsPlayed || 0}
        </div>
      </button>`;
    }).join('');

    el.querySelectorAll('[data-player-id]').forEach(btn => {
      btn.addEventListener('click', () => this.openPlayerDetail(btn.getAttribute('data-player-id')));
    });
  },

  async openPlayerDetail(id) {
    try {
      const { player } = await API.playerDetail(id);
      const modal = document.getElementById('player-detail-modal');
      const u = player.user || {};
      const s = player.summary || {};
      const hud = player.hud || {};
      document.getElementById('player-detail-title').textContent = u.nickname || '玩家详情';
      const profit = s.profit || 0;
      const profitText = (profit > 0 ? '+' : '') + profit;
      const winRate = Math.min(100, Math.round((s.winRate || 0) * 100));
      const body = document.getElementById('player-detail-body');
      const records = player.records || [];
      body.innerHTML = `
        <div class="player-detail-hero ${profit < 0 ? 'loss' : ''}">
          <div class="hero-label">累计盈亏</div>
          <div class="hero-value">${profitText}</div>
          <div class="hero-sub">${s.sessions || 0} 局 · 胜率 ${winRate}% · 场均 ${s.avgProfit || 0}</div>
        </div>
        <div class="stat-grid" style="margin-bottom:8px;">
          <div class="stat"><div class="stat-val">${s.wins || 0}</div><div class="stat-label">盈利局</div></div>
          <div class="stat"><div class="stat-val">${s.losses || 0}</div><div class="stat-label">亏损局</div></div>
          <div class="stat"><div class="stat-val">${s.handsPlayed || 0}</div><div class="stat-label">手数</div></div>
          <div class="stat"><div class="stat-val">${s.totalBuyIn || 0}</div><div class="stat-label">总买入</div></div>
        </div>
        <h3 class="hud-title">牌桌数据</h3>
        <p class="tab-hint">${hud.hasActionData
          ? `基于 ${hud.sampleHands || 0} 手有行动记录`
          : '暂无行动明细（新打的牌局结算后会开始统计 VPIP 等）'}</p>
        <div class="hud-grid" id="player-detail-hud"></div>
        <h3 class="hud-title">历史牌局</h3>
        <div class="hand-list" id="player-detail-records"></div>
      `;
      this.renderHudGrid('player-detail-hud', hud);
      const list = document.getElementById('player-detail-records');
      if (!records.length) {
        list.innerHTML = '<div class="empty-state small">暂无牌局记录</div>';
      } else {
        list.innerHTML = records.map(h => {
          const p = h.profit || 0;
          const cls = p > 0 ? 'profit-up' : (p < 0 ? 'profit-down' : '');
          const text = (p > 0 ? '+' : '') + p;
          return `<div class="hand-row">
            <div><b>${escapeHtml(h.roomName || h.roomCode)}</b><span class="${cls}">${text}</span></div>
            <div class="muted">${escapeHtml(h.blinds || '')} · ${h.handsPlayed || 0} 手 · ${escapeHtml(h.createdAt || '')}</div>
          </div>`;
        }).join('');
      }
      modal?.classList.add('show');
    } catch (err) {
      this.toast(err.message);
    }
  },

  bindProfile() {
    document.getElementById('form-profile')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nickname = document.getElementById('profile-nickname').value.trim();
      try {
        const { user } = await API.updateMe({ nickname });
        this.onWalletUpdate(user);
        this.toast('昵称已更新');
      } catch (err) {
        this.toast(err.message);
      }
    });
  },

  async loadProfile() {
    try {
      const [{ user }, { items }, { hud }] = await Promise.all([
        API.me(),
        API.myHistory(40),
        API.myHud().catch(() => ({ hud: null }))
      ]);
      this.user = user;
      this.renderUserChrome();
      document.getElementById('profile-nickname').value = user.nickname || '';
      document.getElementById('profile-username').textContent = user.username;
      document.getElementById('stat-chips').textContent = user.chips;
      document.getElementById('stat-hands').textContent = user.totalHands;
      document.getElementById('stat-profit').textContent = (user.totalProfit >= 0 ? '+' : '') + user.totalProfit;
      document.getElementById('stat-wins').textContent = user.wins;

      const hint = document.getElementById('profile-hud-hint');
      if (hud?.hasActionData) {
        hint.textContent = `基于 ${hud.sampleHands || 0} 手有行动记录 · VPIP/PFR/C-Bet 等`;
      } else {
        hint.textContent = '暂无行动明细：新打的牌局结束后会开始统计 VPIP / PFR / C-Bet';
      }
      this.renderHudGrid('profile-hud-grid', hud || {});

      const list = document.getElementById('profile-history');
      if (!items.length) {
        list.innerHTML = '<div class="empty-state small">还没有整场牌局记录<br>打完一局结算后会出现在这里</div>';
      } else {
        const reasonText = (r) => ({
          timeout: '时间到结算',
          host: '房主结束',
          ended: '牌局结束'
        }[r] || '已结算');
        list.innerHTML = items.map(h => {
          const profit = h.profit || 0;
          const profitCls = profit > 0 ? 'profit-up' : (profit < 0 ? 'profit-down' : '');
          const profitText = (profit > 0 ? '+' : '') + profit;
          const buyLine = (h.buyIn != null && h.cashOut != null)
            ? `买入 ${h.buyIn} → 带出 ${h.cashOut}`
            : `共 ${h.handsPlayed || 0} 手`;
          return `<div class="hand-row">
            <div>
              <b>${escapeHtml(h.roomName || h.roomCode)}</b>
              <span class="${profitCls}">${profitText}</span>
            </div>
            <div class="muted">${h.blinds} · ${buyLine} · ${h.handsPlayed || 0} 手 · ${reasonText(h.reason)} · ${escapeHtml(h.createdAt || '')}</div>
          </div>`;
        }).join('');
      }
    } catch (err) {
      this.toast(err.message);
    }
  },

  toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return alert(msg);
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatLobbySession(minutes) {
  const m = Number(minutes) || 0;
  if (m < 60) return `${m}分钟局`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h}小时局` : `${h.toFixed(1)}小时局`;
}

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
