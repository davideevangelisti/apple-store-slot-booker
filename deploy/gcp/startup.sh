#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  caddy \
  curl \
  nodejs \
  npm \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2

if ! id -u gmailmcp >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/gmail-chatgpt-mcp --shell /usr/sbin/nologin gmailmcp
fi

mkdir -p \
  /opt/gmail-chatgpt-mcp/releases \
  /etc/gmail-chatgpt-mcp \
  /var/lib/gmail-chatgpt-mcp

chown -R gmailmcp:gmailmcp /opt/gmail-chatgpt-mcp /var/lib/gmail-chatgpt-mcp
chmod 0750 /etc/gmail-chatgpt-mcp

systemctl enable caddy
systemctl start caddy
