# apple-store-slot-booker

Watches Apple Store Rosenstraße München (R045) for Saturday morning Genius Bar appointment slots and automatically books the best one via a headless Chromium browser.

When a slot is detected it navigates `getsupport.apple.com`, selects AirPods 4 (ANC) → audio issue → in-store repair → Rosenstraße → the next Saturday, picks the best available time based on your priority tier, fills in your contact details, and confirms the booking. A confirmation email is sent to your Gmail on success.

## How it works

1. Every 30 minutes (every 5 minutes on Saturday mornings 08:00–12:00 Munich time) the server polls Apple's CDN availability API for store R045.
2. When a Saturday morning slot appears, it launches a headless Chromium browser.
3. The browser navigates the full `getsupport.apple.com` booking wizard.
4. Time-slot priority: **09:00–09:59** (tier 1) → before 09:00 (tier 2) → 10:00–11:59 (tier 3) → afternoon (tier 4). Ties go to the earlier slot.
5. On success: sends a confirmation email via Gmail. On failure: sends a notification email so you can book manually.

## Setup

### 1. Create a GCP project

Go to [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate), create a project, and enable billing.

### 2. Provision the VM from Google Cloud Shell

Open [shell.cloud.google.com](https://shell.cloud.google.com), select your project, then run:

```bash
gcloud config set project YOUR_PROJECT_ID
bash <(curl -sSL https://raw.githubusercontent.com/davideevangelisti/apple-store-slot-booker/main/deploy/gcp/cloud-setup.sh)
```

This creates an `e2-micro` VM in `europe-west3-a` (Frankfurt), installs Node.js, clones this repo, builds the TypeScript, downloads Playwright's Chromium, and installs a systemd service.

### 3. Configure credentials on the VM

SSH in:

```bash
gcloud compute ssh apple-store-booker --zone europe-west3-a
```

Create the env file:

```bash
sudo nano /etc/apple-store-booker/app.env
```

Minimum required contents (copy from `.env.example` and fill in):

```bash
PORT=3000
HOST=127.0.0.1
PUBLIC_BASE_URL=http://YOUR_VM_IP:3000

GOOGLE_CLIENT_ID=...          # from Google Cloud OAuth client
GOOGLE_CLIENT_SECRET=...

APPLE_STORE_ENABLED=true
APPLE_STORE_NOTIFY_EMAIL=your@gmail.com
APPLE_STORE_AUTO_BOOK=true
APPLE_BOOKING_FIRST_NAME=Davide
APPLE_BOOKING_LAST_NAME=Evangelisti
APPLE_BOOKING_PHONE=+49 174 8951232
APPLE_BOOKING_EMAIL=your@gmail.com
APPLE_BOOKING_DEBUG_DIR=/var/lib/apple-store-booker/debug
```

### 4. Start the service

```bash
sudo systemctl start apple-store-booker
sudo journalctl -u apple-store-booker -f
```

### 5. Connect your Gmail account

The server exposes a Gmail MCP gateway that it also uses to send notification and confirmation emails. Open `http://YOUR_VM_IP:3000/` in a browser and follow the OAuth flow to connect your Google account.

## Google OAuth setup

1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add `http://YOUR_VM_IP:3000/oauth/google/callback` as an authorized redirect URI
4. Copy the Client ID and Secret into `app.env`

## Environment variables

See [`.env.example`](.env.example) for the full list with descriptions.

Key auto-booking variables:

| Variable | Default | Description |
|---|---|---|
| `APPLE_STORE_ENABLED` | `false` | Set to `true` to activate the watcher |
| `APPLE_STORE_AUTO_BOOK` | `false` | Set to `true` to book automatically |
| `APPLE_STORE_NOTIFY_EMAIL` | — | Gmail address for notifications |
| `APPLE_BOOKING_FIRST_NAME` | — | First name for the booking form |
| `APPLE_BOOKING_LAST_NAME` | — | Last name |
| `APPLE_BOOKING_PHONE` | — | Phone number (e.g. `+49 174 8951232`) |
| `APPLE_BOOKING_EMAIL` | notify email | Email for the booking form |
| `APPLE_BOOKING_SLOT_TIER1_START` | `9` | Preferred window start (Munich hour) |
| `APPLE_BOOKING_SLOT_TIER1_END` | `10` | Preferred window end (exclusive) |
| `APPLE_BOOKING_DEBUG_DIR` | — | Directory for step-by-step screenshots |
| `CHROMIUM_PATH` | — | Override Playwright's bundled Chromium |

## Local development

```bash
npm install
npm run setup:chromium   # one-time: downloads Chromium (~130 MB)
cp .env.example .env
# fill in .env
npm run dev
```

## Notes

- The booking wizard on `getsupport.apple.com` is a React SPA that changes periodically. If auto-booking stops working, set `APPLE_BOOKING_DEBUG_DIR` to capture step-by-step screenshots and diagnose which selector broke.
- The server uses guest booking (name + email + phone) — no Apple ID is required for the booking form.
- One booking is made per Saturday. Once booked (or notified), the watcher ignores that Saturday date and resets for the next one at midnight.
