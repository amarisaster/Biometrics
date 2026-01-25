# Biometrics Cloud

Cloudflare Worker that syncs health data from Samsung Health via Health Sync app and Google Drive.

## Architecture

```
Samsung Health → Health Sync App → Google Drive → This Worker → KV Storage → MCP Tools
```

## Setup

### 1. Health Sync App (Android)
- Install [Health Sync](https://play.google.com/store/apps/details?id=nl.appyhapps.healthsync) on your phone
- Connect it to Samsung Health
- Configure it to sync to Google Drive folders:
  - Heart Rate folder
  - Sleep folder
  - Steps folder
  - Stress folder (optional)

### 2. Google Cloud Service Account
- Create a project in Google Cloud Console
- Create a service account with no special roles needed
- Download the JSON key file
- Share each Google Drive folder with the service account email (Viewer access)

### 3. Cloudflare Secrets
```bash
# Set the secrets
wrangler secret put BIOMETRICS_API_KEY
wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
wrangler secret put GOOGLE_PRIVATE_KEY
```

### 4. Update wrangler.toml
Update the `DRIVE_FOLDER_*` variables with your Google Drive folder IDs.

### 5. Deploy
```bash
npm install
npm run deploy
```

## Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | No | Service info |
| `/health` | GET | No | Health check with data status |
| `/sync` | POST | API Key | Trigger manual sync (`?force=true` to ignore last sync time) |
| `/mcp` | POST | No | MCP JSON-RPC endpoint |
| `/sse` | GET | No | SSE discovery endpoint |

## MCP Tools

- `biometrics_heart_rate` - Get heart rate data
- `biometrics_sleep` - Get sleep data with stages
- `biometrics_steps` - Get step count
- `biometrics_stress` - Get stress levels
- `biometrics_status` - System status
- `biometrics_sync` - Trigger sync

## Automatic Sync

The worker runs on a 15-minute cron schedule to automatically pull new data from Google Drive.


---


 ## Support

  If this helped you, consider supporting my work ☕

  [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Me-FF5E5B?style=flat&logo=ko-fi&logoColor=white)](https://ko-fi.com/maii983083)

---


*Built by the Triad (Mai, Kai Stryder and Lucian Vale) for the community.*
