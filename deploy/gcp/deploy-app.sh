#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
: "${PROJECT_ID:?Set PROJECT_ID or run gcloud config set project YOUR_PROJECT_ID}"
DOMAIN="${DOMAIN:?Set DOMAIN to the public HTTPS hostname, for example mcp.example.com}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID from your Google OAuth web client}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET from your Google OAuth web client}"

INSTANCE_NAME="${INSTANCE_NAME:-gmail-chatgpt-mcp}"
ZONE="${ZONE:-us-central1-a}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://${DOMAIN}}"
GOOGLE_REDIRECT_URI="${GOOGLE_REDIRECT_URI:-${PUBLIC_BASE_URL}/oauth/google/callback}"
GOOGLE_SCOPES="${GOOGLE_SCOPES:-https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send}"
MCP_SCOPES="${MCP_SCOPES:-gmail.read gmail.draft gmail.modify gmail.send}"
STORE_PATH="${STORE_PATH:-/var/lib/gmail-chatgpt-mcp/store.json}"
REMINDER_CHECK_INTERVAL_SECONDS="${REMINDER_CHECK_INTERVAL_SECONDS:-60}"
REMOTE_RELEASE_ROOT="/opt/gmail-chatgpt-mcp/releases"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
export npm_config_cache="${npm_config_cache:-$PROJECT_ROOT/.npm-cache}"

quote_env() {
  printf "%q" "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command gcloud
require_command npm
require_command tar

cd "$PROJECT_ROOT"
if [ "${SKIP_LOCAL_NPM_CI:-0}" != "1" ]; then
  npm ci
fi
npm run build

ARCHIVE="$TMP_DIR/gmail-chatgpt-mcp-release.tgz"
tar -czf "$ARCHIVE" \
  package.json \
  package-lock.json \
  dist \
  README.md

ENV_FILE="$TMP_DIR/gmail-chatgpt-mcp.env"
{
  printf "PORT=%s\n" "3000"
  printf "HOST=%s\n" "127.0.0.1"
  printf "PUBLIC_BASE_URL=%s\n" "$(quote_env "$PUBLIC_BASE_URL")"
  printf "ALLOWED_HOSTS=%s\n" "$(quote_env "$DOMAIN")"
  printf "GOOGLE_CLIENT_ID=%s\n" "$(quote_env "$GOOGLE_CLIENT_ID")"
  printf "GOOGLE_CLIENT_SECRET=%s\n" "$(quote_env "$GOOGLE_CLIENT_SECRET")"
  printf "GOOGLE_REDIRECT_URI=%s\n" "$(quote_env "$GOOGLE_REDIRECT_URI")"
  printf "GOOGLE_SCOPES=%s\n" "$(quote_env "$GOOGLE_SCOPES")"
  printf "MCP_SCOPES=%s\n" "$(quote_env "$MCP_SCOPES")"
  printf "STORE_PATH=%s\n" "$(quote_env "$STORE_PATH")"
  printf "REMINDER_CHECK_INTERVAL_SECONDS=%s\n" "$(quote_env "$REMINDER_CHECK_INTERVAL_SECONDS")"
} > "$ENV_FILE"

CADDYFILE="$TMP_DIR/Caddyfile"
cat > "$CADDYFILE" <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
  }
}
EOF

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud compute scp --zone "$ZONE" "$ARCHIVE" "$ENV_FILE" "$CADDYFILE" "$SCRIPT_DIR/gmail-chatgpt-mcp.service" "${INSTANCE_NAME}:/tmp/"

REMOTE_COMMAND='
set -euo pipefail
release_dir="'"$REMOTE_RELEASE_ROOT"'/$(date +%Y%m%d%H%M%S)"
sudo mkdir -p "$release_dir" /etc/gmail-chatgpt-mcp /var/lib/gmail-chatgpt-mcp
sudo tar -xzf /tmp/gmail-chatgpt-mcp-release.tgz -C "$release_dir"
sudo chown -R gmailmcp:gmailmcp /opt/gmail-chatgpt-mcp /var/lib/gmail-chatgpt-mcp
cd "$release_dir"
sudo -u gmailmcp npm ci --omit=dev
sudo ln -sfn "$release_dir" /opt/gmail-chatgpt-mcp/current
sudo mv /tmp/gmail-chatgpt-mcp.env /etc/gmail-chatgpt-mcp/gmail-chatgpt-mcp.env
sudo chown root:gmailmcp /etc/gmail-chatgpt-mcp/gmail-chatgpt-mcp.env
sudo chmod 0640 /etc/gmail-chatgpt-mcp/gmail-chatgpt-mcp.env
sudo mv /tmp/gmail-chatgpt-mcp.service /etc/systemd/system/gmail-chatgpt-mcp.service
sudo chown root:root /etc/systemd/system/gmail-chatgpt-mcp.service
sudo chmod 0644 /etc/systemd/system/gmail-chatgpt-mcp.service
sudo mv /tmp/Caddyfile /etc/caddy/Caddyfile
sudo chown root:root /etc/caddy/Caddyfile
sudo chmod 0644 /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable gmail-chatgpt-mcp
sudo systemctl restart gmail-chatgpt-mcp
sudo systemctl reload caddy || sudo systemctl restart caddy
sudo systemctl --no-pager --full status gmail-chatgpt-mcp | sed -n "1,18p"
'

gcloud compute ssh "$INSTANCE_NAME" --zone "$ZONE" --command "$REMOTE_COMMAND"

cat <<EOF

Deployment complete.

Health check:
  curl -sS ${PUBLIC_BASE_URL}/healthz

ChatGPT connector URL:
  ${PUBLIC_BASE_URL}/mcp

Google OAuth redirect URI:
  ${GOOGLE_REDIRECT_URI}

EOF
