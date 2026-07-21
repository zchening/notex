#!/usr/bin/env bash
# NoteSync 一键部署脚本（Linux，需 root）
# 多笔记版：每个 URL 路径 = 一个独立笔记 = 一个独立口令
# 用法：将 server.js、index.html、本脚本放同一目录，然后 bash install.sh
set -euo pipefail

DOMAIN="${NOTESYNC_DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  read -rp "请输入域名（如 note.example.com）: " DOMAIN
  if [ -z "$DOMAIN" ]; then echo "!! 域名不能为空"; exit 1; fi
fi
APP_DIR="/opt/notesync"
PORT=8080
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 检查同目录下是否有 server.js 和 index.html
if [ ! -f "$SCRIPT_DIR/server.js" ] || [ ! -f "$SCRIPT_DIR/index.html" ]; then
  echo "!! 缺少 server.js 或 index.html，请将它们与本脚本放同一目录后重试"
  exit 1
fi

echo "==> [1/6] 安装依赖（Node.js / nginx / certbot）"
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y curl nginx software-properties-common
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  apt-get install -y certbot python3-certbot-nginx
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl nginx
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  fi
  yum install -y certbot python3-certbot-nginx
else
  echo "不支持的系统，请手动安装 Node/nginx/certbot"; exit 1
fi
echo "node: $(node -v 2>/dev/null || echo MISSING)"

echo "==> [2/6] 部署应用文件"
mkdir -p "$APP_DIR/data/notes"
id www-data >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin www-data 2>/dev/null || true
cp "$SCRIPT_DIR/server.js" "$APP_DIR/server.js"
cp "$SCRIPT_DIR/index.html" "$APP_DIR/index.html"

echo "==> [3/6] 写入 nginx 配置"
cat > /etc/nginx/conf.d/$DOMAIN.conf <<NGINXEOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;

    add_header Content-Security-Policy "default-src 'self'; script-src 'unsafe-inline' cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src 'self' https://res.cloudinary.com data:; connect-src 'self' https://api.cloudinary.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    client_max_body_size 256k;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
NGINXEOF

echo "==> [4/6] 写入 systemd 服务并启动"
cat > /etc/systemd/system/notesync.service <<SRVEOF
[Unit]
Description=NoteSync end-to-end encrypted notes
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=on-failure
RestartSec=3
User=www-data
Environment=PORT=$PORT

[Install]
WantedBy=multi-user.target
SRVEOF

chown -R www-data:www-data "$APP_DIR"
nginx -t
systemctl daemon-reload
systemctl enable --now notesync
systemctl restart nginx

echo "==> [5/6] 申请 HTTPS 证书（需 DNS 已指向本机 + 防火墙放行 80）"
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m you@example.com --redirect; then
  echo "证书申请成功"
else
  echo "!! 证书自动申请失败——请确认："
  echo "   1) DNS 中 $DOMAIN 的 A 记录已指向本服务器公网 IP"
  echo "   2) 腾讯云防火墙/安全组已放行 80 和 443"
  echo "   手动重试：certbot --nginx -d $DOMAIN"
fi

echo "==> [6/6] 完成"
echo "本地健康检查：curl -s http://127.0.0.1:$PORT/healthz"
echo "浏览器访问：https://$DOMAIN  （根路径显示提示页，加任意笔记名访问）"
