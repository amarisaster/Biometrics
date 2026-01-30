# 🛡️ Security & Privacy

Biometrics Cloud handles **sensitive health data**—heart rate, sleep patterns, stress levels, step counts. This document explains the data flow, security architecture, and your responsibilities.

---

## ⚠️ Sensitivity Notice

Biometric data is **personal health information**. This system is designed for personal use, giving *you* access to *your own* data through your AI companion.

---

## 🔄 Data Flow Architecture

Your health data moves through a pipeline:

```
Samsung Health → Health Sync App → Google Drive → This Worker → KV Storage → MCP Tools
```

### What Each Step Does

| Stage | What Happens |
|-------|--------------|
| **Samsung Health** | Source of your biometric data on your device |
| **Health Sync App** | Exports data to Google Drive (third-party Android app) |
| **Google Drive** | Intermediate storage—your Drive, your folders |
| **Cloudflare Worker** | Fetches from your Drive, processes, exposes via API |
| **KV Storage** | Caches data on Cloudflare for faster access |
| **MCP Tools** | Your AI companion accesses data through these endpoints |

> **What this means:** You control every link in this chain. Your Samsung Health, your Health Sync configuration, your Google Drive, your Cloudflare worker. No third-party servers you don't control.

---

## 🔑 Key Security Features

### Your Accounts, Your Data

Every service in the pipeline is **yours**:
- Your Samsung Health account
- Your Google Drive storage
- Your Cloudflare worker deployment
- Your KV namespace

No shared infrastructure. No multi-tenant databases. Your health data doesn't touch anyone else's systems.

### Google Drive as Intermediary

Google Drive acts as the bridge between your phone and the cloud worker. The worker authenticates to **your** Drive with credentials you provide.

> **What this means:** The Health Sync app writes to your Drive. The worker reads from your Drive. Google's security protects the data in transit and at rest. You're leveraging infrastructure you already trust.

### Environment Secrets

All credentials (Google OAuth tokens, API keys) are stored as **Cloudflare environment secrets**, never in code.

> **What this means:** Even if your code is public, your credentials are safe. Cloudflare encrypts secrets at rest and only injects them at runtime.

### KV Storage Isolation

Cached data in Cloudflare KV is scoped to **your** account and namespace. No cross-account access is possible.

> **What this means:** Your cached health data is isolated. Other Cloudflare users cannot access your KV namespace.

---

## 🔐 Best Practices

### Enable 2FA on All Connected Accounts

| Platform | Why It Matters |
|----------|----------------|
| **Samsung Account** | Protects your health data at the source |
| **Google Account** | Protects Drive access and OAuth tokens |
| **Cloudflare** | Protects your worker and KV storage |
| **GitHub** | Protects your code if the repo is connected |

### Review Google Drive Permissions

Periodically check which apps have access to your Google Drive:
1. Go to Google Account → Security → Third-party apps
2. Review access for Health Sync and your worker
3. Revoke anything you don't recognize

### Limit Health Sync Export Scope

In Health Sync, only export the data types you actually need. Less data exported = smaller exposure surface.

### Secure Your Phone

Your Samsung Health data starts on your phone. Use:
- Strong screen lock
- Biometric authentication
- Device encryption (usually on by default)

### Rotate Credentials if Compromised

If you suspect any credential exposure:
1. Revoke Google OAuth tokens immediately
2. Regenerate Cloudflare API tokens
3. Clear KV storage if needed
4. Re-authorize with fresh credentials

---

## 🚫 What This System Does NOT Do

- ❌ Send your health data to third-party analytics
- ❌ Share data with other users or services
- ❌ Store data on servers you don't control
- ❌ Sell or monetize your health information
- ❌ Access data beyond what you explicitly configure

---

## 🔍 Transparency

This project is fully open source. You can audit every line of code. There are no hidden endpoints, no telemetry, no data collection.

Your body, your data, your control.
