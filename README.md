# Drive Collector Bot

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

Set the following environment variables:

- `BOT_TOKEN`: Your Telegram bot token
- `PORT`: Port for health check server (default: 3000)
- For multi-instance deployment:
  - `INSTANCE_COUNT`: Total number of instances
  - `INSTANCE_ID`: Unique ID for this instance (1 to INSTANCE_COUNT)

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

For Zeabur deployments, tests run locally before deployment. Consider adding test steps to your Dockerfile if needed.

## Architecture

- `src/core/`: Core business logic (TaskManager)
- `src/services/`: External integrations (Telegram, Rclone)
- `src/repositories/`: Data persistence layer
- `src/ui/`: User interface templates
- `src/utils/`: Utility functions
- `src/bot/`: Bot event handling (Dispatcher)
- `src/modules/`: Additional modules (AuthGuard, etc.)

## Deployment

For zero-downtime deployments with multiple instances:

1. Set `INSTANCE_COUNT` and `INSTANCE_ID` environment variables
2. Use message sharding to prevent duplicate processing
3. Consider using Redis for shared state in production

## License

ISC