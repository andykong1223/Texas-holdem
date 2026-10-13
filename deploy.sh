#!/usr/bin/env bash
# Texas Hold'em H5 — Docker 部署脚本
#
# 用法：
#   1) 在服务器项目目录本地部署：
#        ./deploy.sh
#        ./deploy.sh up          # 同默认
#        ./deploy.sh build       # 仅构建
#        ./deploy.sh down        # 停止并删除容器
#        ./deploy.sh logs        # 看日志
#        ./deploy.sh restart     # 重启
#        ./deploy.sh status      # 状态
#
#   2) 本机通过 SSH 部署到远端（需服务器已装 Docker / Compose）：
#        ./deploy.sh remote user@your-server /opt/texas-holdem
#        ./deploy.sh remote user@your-server /opt/texas-holdem main
#
# 环境变量见 .env.example（首次会自动从示例生成 .env）

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

COMPOSE=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    echo "错误: 未找到 docker compose / docker-compose，请先安装 Docker。" >&2
    exit 1
  fi
fi

ensure_env() {
  if [[ ! -f .env ]]; then
    if [[ -f .env.example ]]; then
      cp .env.example .env
      # 生成随机 JWT
      if command -v openssl >/dev/null 2>&1; then
        local secret
        secret="$(openssl rand -hex 32)"
        if grep -q '^JWT_SECRET=' .env; then
          sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=${secret}|" .env && rm -f .env.bak
        else
          echo "JWT_SECRET=${secret}" >> .env
        fi
      fi
      echo "已生成 .env（请按需修改 HOST_PORT / JWT_SECRET）"
    else
      echo "错误: 缺少 .env 与 .env.example" >&2
      exit 1
    fi
  fi
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
  if [[ -z "${JWT_SECRET:-}" || "${JWT_SECRET}" == "please-change-me-to-a-long-random-string" ]]; then
    echo "警告: 请修改 .env 中的 JWT_SECRET 为强随机值。" >&2
  fi
  mkdir -p "${DATA_DIR:-./data}"
}

cmd_build() {
  ensure_env
  echo "==> 构建镜像 ${IMAGE_NAME:-texas-holdem-h5:latest}"
  "${COMPOSE[@]}" build --pull
}

cmd_up() {
  ensure_env
  echo "==> 构建并启动"
  "${COMPOSE[@]}" up -d --build --remove-orphans
  echo "==> 当前状态"
  "${COMPOSE[@]}" ps
  local port="${HOST_PORT:-3000}"
  echo
  echo "部署完成。访问: http://<服务器IP>:${port}"
  echo "查看日志: ./deploy.sh logs"
}

cmd_down() {
  ensure_env
  "${COMPOSE[@]}" down
}

cmd_restart() {
  ensure_env
  "${COMPOSE[@]}" restart
}

cmd_logs() {
  ensure_env
  "${COMPOSE[@]}" logs -f --tail=200
}

cmd_status() {
  ensure_env
  "${COMPOSE[@]}" ps
  echo
  docker ps --filter "name=texas-holdem" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

# 远端部署：同步代码到服务器后执行 ./deploy.sh up
# 参数: remote <user@host> <remote_dir> [branch]
cmd_remote() {
  local ssh_target="${1:-}"
  local remote_dir="${2:-/opt/texas-holdem}"
  local branch="${3:-main}"
  if [[ -z "$ssh_target" ]]; then
    echo "用法: ./deploy.sh remote user@host [remote_dir] [branch]" >&2
    exit 1
  fi

  echo "==> 远端: ${ssh_target}:${remote_dir} (branch=${branch})"

  # 确保远端目录与基础依赖
  ssh -o StrictHostKeyChecking=accept-new "$ssh_target" bash -s <<EOF
set -euo pipefail
sudo mkdir -p '${remote_dir}'
sudo chown -R "\$USER":"\$USER" '${remote_dir}'
if ! command -v docker >/dev/null 2>&1; then
  echo "远端未安装 Docker，请先安装后再部署。" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  echo "远端未安装 Docker Compose 插件。" >&2
  exit 1
fi
EOF

  # 优先用 git；否则 rsync 当前目录
  if ssh "$ssh_target" "test -d '${remote_dir}/.git'"; then
    echo "==> 远端已有 git 仓库，拉取 ${branch}"
    ssh "$ssh_target" bash -s <<EOF
set -euo pipefail
cd '${remote_dir}'
git fetch origin
git checkout '${branch}'
git pull --ff-only origin '${branch}'
EOF
  elif [[ -d "$ROOT_DIR/.git" ]]; then
    echo "==> 克隆/更新仓库到远端"
    # 默认使用当前 origin；若没有则推 HTTPS 公共地址
    local repo_url
    repo_url="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)"
    if [[ -z "$repo_url" ]]; then
      repo_url="https://github.com/andykong1223/Texas-holdem.git"
    fi
    # SSH remote 在服务器上可能无密钥，尽量转成 HTTPS
    if [[ "$repo_url" == git@github.com:* ]]; then
      repo_url="https://github.com/${repo_url#git@github.com:}"
    elif [[ "$repo_url" == ssh://git@github.com/* ]]; then
      repo_url="https://github.com/${repo_url#ssh://git@github.com/}"
    fi
    ssh "$ssh_target" bash -s <<EOF
set -euo pipefail
if [[ ! -d '${remote_dir}/.git' ]]; then
  git clone --branch '${branch}' '${repo_url}' '${remote_dir}'
else
  cd '${remote_dir}'
  git fetch origin
  git checkout '${branch}'
  git pull --ff-only origin '${branch}'
fi
EOF
  else
    echo "==> 使用 rsync 同步本地文件"
    rsync -az --delete \
      --exclude node_modules \
      --exclude data \
      --exclude .git \
      --exclude '.env' \
      "$ROOT_DIR/" "${ssh_target}:${remote_dir}/"
  fi

  # 若远端没有 .env，上传本地 .env 或让远端从 example 生成
  if [[ -f "$ROOT_DIR/.env" ]]; then
    echo "==> 上传 .env"
    scp "$ROOT_DIR/.env" "${ssh_target}:${remote_dir}/.env"
  fi

  echo "==> 远端执行 deploy.sh up"
  ssh "$ssh_target" bash -s <<EOF
set -euo pipefail
cd '${remote_dir}'
chmod +x deploy.sh
./deploy.sh up
EOF
}

usage() {
  cat <<'USAGE'
用法:
  ./deploy.sh [up|build|down|restart|logs|status]
  ./deploy.sh remote <user@host> [remote_dir] [branch]

示例:
  ./deploy.sh
  ./deploy.sh remote root@1.2.3.4 /opt/texas-holdem
USAGE
}

main() {
  local action="${1:-up}"
  case "$action" in
    up|start) shift || true; cmd_up "$@" ;;
    build) shift || true; cmd_build "$@" ;;
    down|stop) shift || true; cmd_down "$@" ;;
    restart) shift || true; cmd_restart "$@" ;;
    logs) shift || true; cmd_logs "$@" ;;
    status|ps) shift || true; cmd_status "$@" ;;
    remote) shift; cmd_remote "$@" ;;
    -h|--help|help) usage ;;
    *)
      echo "未知命令: $action" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
