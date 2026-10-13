const API = {
  tokenKey: 'holdem_token',
  userKey: 'holdem_user',

  getToken() {
    try { return localStorage.getItem(this.tokenKey) || ''; } catch (_) { return ''; }
  },
  setSession(token, user) {
    localStorage.setItem(this.tokenKey, token);
    localStorage.setItem(this.userKey, JSON.stringify(user));
  },
  clearSession() {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.userKey);
  },
  getCachedUser() {
    try { return JSON.parse(localStorage.getItem(this.userKey) || 'null'); } catch (_) { return null; }
  },
  async request(path, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`/api${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  },
  register(body) { return this.request('/auth/register', { method: 'POST', body: JSON.stringify(body) }); },
  login(body) { return this.request('/auth/login', { method: 'POST', body: JSON.stringify(body) }); },
  me() { return this.request('/auth/me'); },
  updateMe(body) { return this.request('/me', { method: 'PATCH', body: JSON.stringify(body) }); },
  myHistory(limit = 30) { return this.request(`/me/history?limit=${limit}`); },
  lobbyRooms() { return this.request('/lobby/rooms'); },
  recentHands() { return this.request('/lobby/recent-hands'); },
  listSessions(limit = 40) { return this.request(`/sessions?limit=${limit}`); },
  sessionDetail(id) { return this.request(`/sessions/${id}`); },
  playerStats(limit = 50) { return this.request(`/players/stats?limit=${limit}`); },
  playerDetail(id) { return this.request(`/players/${id}`); },
  myHud() { return this.request('/me/hud'); },
  adminStats() { return this.request('/admin/stats'); },
  adminUsers(q = '') { return this.request(`/admin/users?q=${encodeURIComponent(q)}`); },
  adminPatchUser(id, body) {
    return this.request(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }
};

window.API = API;
