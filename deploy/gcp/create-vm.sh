#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
: "${PROJECT_ID:?Set PROJECT_ID or run gcloud config set project YOUR_PROJECT_ID}"
INSTANCE_NAME="${INSTANCE_NAME:-gmail-chatgpt-mcp}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"
ADDRESS_NAME="${ADDRESS_NAME:-gmail-chatgpt-mcp-ip}"
NETWORK="${NETWORK:-default}"
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-10GB}"
BOOT_DISK_TYPE="${BOOT_DISK_TYPE:-pd-standard}"
IMAGE_FAMILY="${IMAGE_FAMILY:-debian-12}"
IMAGE_PROJECT="${IMAGE_PROJECT:-debian-cloud}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable compute.googleapis.com

if ! gcloud compute addresses describe "$ADDRESS_NAME" --region "$REGION" >/dev/null 2>&1; then
  gcloud compute addresses create "$ADDRESS_NAME" --region "$REGION"
fi

STATIC_IP="$(gcloud compute addresses describe "$ADDRESS_NAME" --region "$REGION" --format='value(address)')"

if ! gcloud compute firewall-rules describe allow-gmail-mcp-http-https >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-gmail-mcp-http-https \
    --network "$NETWORK" \
    --allow tcp:80,tcp:443 \
    --target-tags gmail-mcp \
    --description "Allow HTTPS and ACME HTTP validation for Gmail MCP"
fi

if gcloud compute instances describe "$INSTANCE_NAME" --zone "$ZONE" >/dev/null 2>&1; then
  echo "VM $INSTANCE_NAME already exists in $ZONE."
else
  gcloud compute instances create "$INSTANCE_NAME" \
    --zone "$ZONE" \
    --machine-type "$MACHINE_TYPE" \
    --network "$NETWORK" \
    --address "$STATIC_IP" \
    --tags gmail-mcp \
    --boot-disk-size "$BOOT_DISK_SIZE" \
    --boot-disk-type "$BOOT_DISK_TYPE" \
    --image-family "$IMAGE_FAMILY" \
    --image-project "$IMAGE_PROJECT" \
    --metadata-from-file startup-script="$SCRIPT_DIR/startup.sh"
fi

cat <<EOF

VM is ready or being initialized.

Static IP: $STATIC_IP
DNS needed: point your MCP domain A record to $STATIC_IP

After DNS resolves, run:
  DOMAIN=your.domain.example GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... ./deploy/gcp/deploy-app.sh

Google OAuth redirect URI to add:
  https://your.domain.example/oauth/google/callback

EOF
