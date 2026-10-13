# H5 朋友私房改造清单

> 本地已可运行：`npm start` → http://localhost:3000  
> **License 警告**：本仓库为 Custom Source-Available，**禁止未经授权的修改 / 分发 / 商用**。个人试用可；若要二次开发上线，请换 MIT 项目（如 `ptwu/distributed-texasholdem`）或联系作者授权。

## 文件地图

| 文件 | 职责 |
|------|------|
| `server.js` | 房间、发牌、下注、边池、摊牌、Socket 事件 |
| `public/index.html` | 首页 / 建房 / 加入 / 牌桌 DOM |
| `public/client.js` | Socket 客户端、UI 渲染、操作按钮 |
| `public/style.css` | 桌面 + 少量 `@media (max-width: 768px)` |

## P0 — 私房邀请（必做）

| 改动 | 改哪里 | 做法 |
|------|--------|------|
| 深链进房 | `client.js` 启动逻辑 | 读 `?room=XXXXXX`，自动打开 Join 并填房间号 |
| 一键分享链接 | `copyCode()`（约 969 行） | 复制 `https://你的域名/?room=CODE`，不只复制房间号 |
| 私房默认 | `index.html` Host 表单 | 默认要求密码，或隐藏「公开房间列表」 |
| 隐藏大厅 | `screen-join` | 朋友局可去掉 `list-public-rooms`，只留「输入房间号」 |

## P0 — 竖屏 H5 牌桌（必做）

| 改动 | 改哪里 | 做法 |
|------|--------|------|
| 安全区 / 视口 | `index.html` `<head>` | 已有 viewport；补 `viewport-fit=cover`、禁用橡皮筋滚动 |
| 座位布局 | `style.css` + `client.js` `renderTable` | 手机竖屏：自己固定在底部，对手围椭圆；加大触控热区 |
| 操作栏 | `#actions` / `.actions-row` | 固定底部大按钮：Fold / Check·Call / Raise，Raise 用滑条 |
| 侧栏 | `#sidebar` | 手机改为底部抽屉或隐藏，别占左右宽度 |
| 聊天 | `#chat-container` | 默认收起，不挡牌面 |

现有移动端样式仅约 `style.css` 401 行起一小段，**不够当正式 H5**。

## P1 — 朋友局体验

| 改动 | 改哪里 |
|------|--------|
| 中文文案 | `index.html` + `client.js` alert/文案 |
| 昵称本地记忆 | `localStorage` 记住 nickname |
| 行动倒计时更醒目 | 牌桌中央 / 自己座位进度条（服务端已有 timer） |
| 断线重连 | `server.js` + `client.js`：按 nickname/token 回座（当前重连能力弱） |

## P2 — 可选

- 观战 / 中途入座：服务端已有，按产品收紧规则即可  
- 音效：已有 Web Audio，可按回合加强反馈  
- HTTPS 部署 + Nginx WebSocket 反代  

## 建议先别做

注册登录、充值、大厅匹配、俱乐部、持久化数据库（朋友局内存房间足够）。

## 已完成（本仓库二次改动）

- [x] 中文 UI / 私房入口（去掉公开大厅浏览）
- [x] `?room=` 深链进房 + 「邀请」复制链接
- [x] 昵称 `localStorage` 记忆
- [x] 竖屏布局：侧栏抽屉、底部大按钮、自己坐牌桌底部
- [x] Toast 提示

## 后续可做

1. 断线按昵称回座  
2. 部署到 HTTPS（手机剪贴板更稳）  
3. 更精致的牌面/动画  
