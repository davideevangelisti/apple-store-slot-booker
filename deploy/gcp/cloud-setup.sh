#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Run this from Google Cloud Shell to provision a VM and deploy
# the apple-store-slot-booker service.
#
# Usage:
#   1. Open https://shell.cloud.google.com
#   2. Create or select a GCP project:
#        gcloud projects create apple-booker-XXXXX --name "Apple Store Booker"
#        gcloud config set project apple-booker-XXXXX
#        (then enable billing in the Cloud Console)
#   3. Run:
#        bash <(curl -sSL https://raw.githubusercontent.com/davideevangelisti/apple-store-slot-booker/main/deploy/gcp/cloud-setup.sh)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

INSTANCE_NAME="${INSTANCE_NAME:-apple-store-booker}"
ZONE="${ZONE:-europe-west3-a}"
REGION="${ZONE%-*}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"
GITHUB_REPO="${GITHUB_REPO:-https://github.com/davideevangelisti/apple-store-slot-booker.git}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"

# ── Resolve project ───────────────────────────────────────────
PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: No GCP project selected."
  echo "Create one at https://console.cloud.google.com/projectcreate then run:"
  echo "  gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi
echo "Project : $PROJECT_ID"
echo "Zone    : $ZONE"
echo "VM name : $INSTANCE_NAME"
echo ""

# ── Enable Compute API ────────────────────────────────────────
gcloud services enable compute.googleapis.com --project="$PROJECT_ID" --quiet

# ── Static IP ─────────────────────────────────────────────────
ADDRESS_NAME="${INSTANCE_NAME}-ip"
if ! gcloud compute addresses describe "$ADDRESS_NAME" --region "$REGION" --project "$PROJECT_ID" &>/dev/null; then
  echo "Reserving static IP..."
  gcloud compute addresses create "$ADDRESS_NAME" --region "$REGION" --project "$PROJECT_ID"
fi
STATIC_IP=$(gcloud compute addresses describe "$ADDRESS_NAME" --region "$REGION" --project "$PROJECT_ID" --format='value(address)')
echo "Static IP: $STATIC_IP"

# ── Firewall ──────────────────────────────────────────────────
FIREWALL_NAME="allow-apple-booker-web"
if ! gcloud compute firewall-rules describe "$FIREWALL_NAME" --project "$PROJECT_ID" &>/dev/null; then
  gcloud compute firewall-rules create "$FIREWALL_NAME" \
    --project "$PROJECT_ID" \
    --network default \
    --allow tcp:80,tcp:443 \
    --target-tags apple-booker \
    --description "HTTP/HTTPS for apple-store-slot-booker"
fi

# ── VM ────────────────────────────────────────────────────────
if gcloud compute instances describe "$INSTANCE_NAME" --zone "$ZONE" --project "$PROJECT_ID" &>/dev/null; then
  echo "VM $INSTANCE_NAME already exists — skipping creation."
else
  echo "Creating VM (this takes ~1 minute)..."

  # Inline startup script installs system-level dependencies on first boot
  STARTUP=$(cat <<'STARTUP_EOF'
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl git nodejs npm \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2
if ! id -u applebooker &>/dev/null; then
  useradd --system --home-dir /var/lib/apple-store-booker --shell /usr/sbin/nologin applebooker
fi
mkdir -p /opt/apple-store-booker /var/lib/apple-store-booker /etc/apple-store-booker
chown -R applebooker:applebooker /opt/apple-store-booker /var/lib/apple-store-booker
chmod 0750 /etc/apple-store-booker
touch /var/lib/apple-store-booker/.startup-done
STARTUP_EOF
)

  gcloud compute instances create "$INSTANCE_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-size=20GB \
    --boot-disk-type=pd-standard \
    --address="$STATIC_IP" \
    --tags=apple-booker \
    --metadata="startup-script=${STARTUP}"

  echo "Waiting 90 s for startup script to finish..."
  sleep 90
fi

# ── Install the app on the VM ─────────────────────────────────
echo ""
echo "Installing apple-store-slot-booker on the VM..."
gcloud compute ssh "$INSTANCE_NAME" --zone "$ZONE" --project "$PROJECT_ID" -- bash -s <<REMOTE
set -euo pipefail

# Clone or update the repo
if [ -d /opt/apple-store-booker/.git ]; then
  sudo git -C /opt/apple-store-booker pull
else
  sudo git clone --branch "${GITHUB_BRANCH}" "${GITHUB_REPO}" /opt/apple-store-booker
fi

sudo chown -R applebooker:applebooker /opt/apple-store-booker
cd /opt/apple-store-booker

# Install Node.js dependencies
sudo -u applebooker npm ci

# Build TypeScript
sudo -u applebooker npm run build

# Download Playwright's Chromium browser (~130 MB, one-time)
sudo -u applebooker npm run setup:chromium

# Install systemd service
sudo cp deploy/gcp/apple-store-booker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable apple-store-booker

echo "App installed successfully."
REMOTE

# ── Summary ───────────────────────────────────────────────────
cat <<SUMMARY

══════════════════════════════════════════════════════
  apple-store-slot-booker deployed!
══════════════════════════════════════════════════════

Static IP : $STATIC_IP

NEXT STEP — configure your credentials on the VM:

  gcloud compute ssh $INSTANCE_NAME --zone $ZONE --project $PROJECT_ID

  Then on the VM:
    sudo nano /etc/apple-store-booker/app.env
    # Fill in the values from .env.example in the repo
    # Minimum required:
    #   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_BASE_URL
    #   APPLE_STORE_ENABLED=true
    #   APPLE_STORE_NOTIFY_EMAIL=your@gmail.com
    #   APPLE_STORE_AUTO_BOOK=true
    #   APPLE_BOOKING_FIRST_NAME=Davide
    #   APPLE_BOOKING_LAST_NAME=Evangelisti
    #   APPLE_BOOKING_PHONE=+49 174 8951232
    #   APPLE_BOOKING_EMAIL=your@gmail.com

  Then start the service:
    sudo systemctl start apple-store-booker
    sudo journalctl -u apple-store-booker -f

SUMMARY
