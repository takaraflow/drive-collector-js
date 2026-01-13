# Drive Collector Bot

[中文文档](docs/README_CN.md)

A modular Telegram bot for transferring files to Rclone remotes.

## Features

- File transfer from Telegram to cloud storage via Rclone
- Batch file processing with progress monitoring
- Queue management for concurrent uploads
- Modular architecture with repositories, services, and UI templates

## Installation

```bash
npm install
```

## Configuration

1.  Copy the `.env.example` file to `.env`:

    ```bash
    cp .env.example .env
    ```

2.  Edit the `.env` file and fill in your credentials. All required environment variables are listed in this file.

## Telegram Webhook Setup

If you expose your bot via webhook (for example, when `NODE_MODE` or `TG_TEST_MODE` routes traffic through a unique endpoint), register the appropriate Telegram webhook before starting the service:

- **Production** – register with the standard Bot API:
  ```bash
  curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=https://yourserver.com/webhook"
  ```
- **Test mode** – Telegram requires `/test` between the bot token and `setWebhook`, and you can point to a dedicated test path:
  ```bash
  curl "https://api.telegram.org/bot${BOT_TOKEN}/test/setWebhook?url=https://yourserver.com/test-webhook"
  ```

Make sure the URL you supply for testing matches the `TG_TEST_MODE` routing you use on your load balancer or proxy.

## QStash Integration

QStash is integrated as a message queuing system to enable reliable asynchronous task processing and webhook handling.

### Purpose and Architecture

- **Decoupling**: Separates task scheduling from execution, allowing for elastic scaling
- **Reliability**: Messages are persisted and retried on failure
- **Webhook Security**: Validates incoming webhooks using cryptographic signatures
- **Topics**: Organized into `download-tasks`, `upload-tasks`, and `system-events`

### Architecture Overview

```
Telegram Bot → QStash → Webhook → Cloudflare Worker LB → Active Instances
     ↓              ↓              ↓              ↓              ↓
   Task Creation  Message Queue   Signature     Load Balance    Task Processing
   (Sync)         (Async)         Verification   (Round Robin)   (Async)
```

### Features

- **Message Publishing**: Send tasks to different topics with optional delays
- **Batch Operations**: Handle multiple related tasks efficiently
- **Signature Verification**: Ensures webhook authenticity
- **Media Group Batching**: Aggregates related media files for batch processing

## Cloudflare Worker Load Balancer

A Cloudflare Worker that distributes QStash webhooks across multiple bot instances for high availability.

### Role and Functions

- **Load Distribution**: Routes incoming webhooks to active instances using round-robin algorithm
- **Health Monitoring**: Tracks instance status via heartbeat mechanism
- **Fault Tolerance**: Automatic failover between Cloudflare Cache (KV) and Upstash Redis
- **Signature Verification**: Validates QStash webhook signatures before forwarding

### Deployment via GitHub Actions

The load balancer is automatically deployed when changes are pushed to `main` or `develop` branches affecting worker files.

**Workflow Triggers:**
- Push to `main` → Production environment
- Push to `develop` → Development environment

**Environment-Specific Configuration:**
- Production: `qstash-lb` worker with production KV namespace
- Development: `qstash-lb-dev` worker with staging KV namespace

## Usage

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

## Testing

Run the test suite:

```bash
npm test
```

Tests cover:
- UI template rendering (progress bars, batch monitors)
- Basic functionality validation

### CI/CD

Tests are automatically run on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

Using GitHub Actions with Node.js 20.x.

## Architecture

- `src/core/`: Core business logic (TaskManager)
- `src/services/`: External integrations (Telegram, Rclone)
- `src/repositories/`: Data persistence layer
- `src/ui/`: User interface templates
- `src/utils/`: Utility functions
- `src/bot/`: Bot event handling (Dispatcher)
- `src/modules/`: Additional modules (AuthGuard, etc.)

## Environment Variables and GitHub Secrets Configuration

### Environment Variables (Runtime)

| Variable | Description | Required |
|----------|-------------|----------|
| `BOT_TOKEN` | Telegram bot token | Yes |
| `API_ID` | Telegram API ID | Yes |
| `API_HASH` | Telegram API Hash | Yes |
| `OWNER_ID` | Bot owner Telegram ID | Yes |
| `PORT` | Server port (default: 7860) | No |
| `QSTASH_TOKEN` | Upstash QStash API token | No* |
| `QSTASH_URL` | QStash endpoint URL | No* |
| `QSTASH_CURRENT_SIGNING_KEY` | Current webhook signing key | No* |
| `QSTASH_NEXT_SIGNING_KEY` | Next webhook signing key | No* |
| `LB_WEBHOOK_URL` | Webhook base URL | No* |
| `INSTANCE_COUNT` | Total instances for sharding | No |
| `INSTANCE_ID` | Current instance ID (1-N) | No |

*Required for QStash features

### GitHub Secrets (Deployment)

| Secret | Production | Development | Description |
|--------|------------|-------------|-------------|
| `CLOUDFLARE_API_TOKEN` | Required | Required | Cloudflare API token for deployment |
| `CLOUDFLARE_ACCOUNT_ID` | Required | Required | Cloudflare account ID |
| `WORKER_NAME` | `qstash-lb` | `qstash-lb-dev` | Worker name |
| `CLOUDFLARE_KV_NAMESPACE_ID` | Production NS | Staging NS | Cache namespace ID |
| `QSTASH_CURRENT_SIGNING_KEY` | Prod Key | Dev Key | Webhook signing key |
| `UPSTASH_REDIS_REST_URL` | Prod URL | Dev URL | Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Prod Token | Dev Token | Redis REST token |

### Secrets Setup Guide

1. **Cloudflare Setup:**
   - Create API token with Workers and KV permissions
   - Get your account ID from Cloudflare dashboard

2. **KV Namespace:**
   - Production: Create `PRODUCTION_NS` namespace
   - Development: Create `STAGING_NS` namespace

3. **QStash Setup:**
   - Get token from Upstash console
   - Generate signing keys for webhook verification

4. **Upstash Redis (Optional):**
   - Create Redis database for KV failover
   - Get REST URL and token

## Local Development and Deployment

### Local Development

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Environment Setup:**
   ```bash
   cp .env.example .env  # Configure your environment variables
   ```

3. **Run Development Server:**
   ```bash
   npm run dev
   ```

4. **Run Tests:**
   ```bash
   npm test
   ```

### Deployment Commands

#### Bot Deployment
- **Docker Build:** `docker build -t drive-collector-bot .`
- **Docker Run:** `docker run -p 7860:7860 drive-collector-bot`
- **Railway:** Automatic deployment on push to main/develop
- **Zeabur:** Automatic deployment via webhook

#### Load Balancer Deployment
- **Automatic:** Via GitHub Actions on push to main/develop
- **Manual Build:** `npm run build-lb` (generates wrangler.build.toml)
- **Manual Deploy:** Use Wrangler CLI or GitHub Actions

### Multi-Environment Setup

The project uses GitHub Environments for isolated production and development deployments:

- **Production Environment:** `main` branch → `qstash-lb` worker
- **Development Environment:** `develop` branch → `qstash-lb-dev` worker

Each environment has separate:
- Cache namespaces (PRODUCTION_NS, STAGING_NS)
- QStash signing keys
- Upstash Redis instances
- Worker names

### Zero-Downtime Deployment

For multi-instance deployments:

1. Set `INSTANCE_COUNT` and `INSTANCE_ID` environment variables
2. Use message sharding to prevent duplicate processing
3. Deploy instances incrementally
4. Use health checks for graceful shutdown

## License

ISC
