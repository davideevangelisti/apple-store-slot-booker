# Deploy to the Smallest GCP VM

This deploys the MCP server to a single Compute Engine `e2-micro` VM with Caddy handling HTTPS.

Defaults:

- VM: `e2-micro`
- Zone: `us-central1-a`
- Disk: 10 GB `pd-standard`
- Public ports: 80 and 443 only
- App listens on `127.0.0.1:3000`
- App data store: `/var/lib/gmail-chatgpt-mcp/store.json`

`e2-micro` is the smallest E2 shared-core VM and is also the Compute Engine free-tier VM in `us-west1`, `us-central1`, or `us-east1`, subject to Google Cloud Free Tier rules.

## 1. Pick a Domain

ChatGPT requires a reachable HTTPS MCP endpoint, so use a real hostname such as:

```text
gmail-mcp.example.com
```

## 2. Create the VM

```bash
./deploy/gcp/create-vm.sh
```

The scripts default to your active `gcloud` project. Set `PROJECT_ID=...` to deploy somewhere else.

The script reserves a static external IP and prints it. Create an `A` record from your domain to that IP.

## 3. Configure Google OAuth

In Google Cloud Console:

- Enable the Gmail API.
- Create an OAuth client of type `Web application`.
- Add this authorized redirect URI:

```text
https://YOUR_DOMAIN/oauth/google/callback
```

For an external/testing app, add your Gmail account as a test user.

## 4. Deploy the App

Run this after DNS points to the VM:

```bash
DOMAIN=gmail-mcp.example.com \
GOOGLE_CLIENT_ID='...' \
GOOGLE_CLIENT_SECRET='...' \
./deploy/gcp/deploy-app.sh
```

## 5. Connect ChatGPT

Use this connector URL:

```text
https://YOUR_DOMAIN/mcp
```

When ChatGPT connects, it will discover this server's OAuth metadata and send you through Google OAuth.

For Plus/Pro-style personal setup, developer mode is only needed to create/add the custom connector. After it is connected, turn developer mode off again; the app should remain under Settings -> Apps, and regular chats can use memory. In the Gmail MCP Gateway app preferences, enable "Reference memories and chats" so ChatGPT can use relevant memories/chats when sharing data with the connector.

Reminder tools are MCP-managed rather than native Gmail Snooze. They store due times in `/var/lib/gmail-chatgpt-mcp/store.json`, use `MCP/Reminders` labels, and the running VM checks for due reminders every 60 seconds by default. Override `REMINDER_CHECK_INTERVAL_SECONDS=...` during deployment if needed.

## Useful Commands

Check the app:

```bash
gcloud compute ssh gmail-chatgpt-mcp --zone us-central1-a -- \
  sudo systemctl status gmail-chatgpt-mcp
```

View logs:

```bash
gcloud compute ssh gmail-chatgpt-mcp --zone us-central1-a -- \
  sudo journalctl -u gmail-chatgpt-mcp -n 100 --no-pager
```

Redeploy:

```bash
DOMAIN=gmail-mcp.example.com \
GOOGLE_CLIENT_ID='...' \
GOOGLE_CLIENT_SECRET='...' \
./deploy/gcp/deploy-app.sh
```

Stop the VM:

```bash
gcloud compute instances stop gmail-chatgpt-mcp --zone us-central1-a
```

Delete the VM and static IP:

```bash
gcloud compute instances delete gmail-chatgpt-mcp --zone us-central1-a
gcloud compute addresses delete gmail-chatgpt-mcp-ip --region us-central1
```

## Notes

- Caddy needs ports 80 and 443 to obtain and renew TLS certificates.
- The Google and ChatGPT OAuth token store lives on the VM disk and is not copied back to your laptop.
- If you choose a European zone for latency, it might not qualify for the Compute Engine free tier.
