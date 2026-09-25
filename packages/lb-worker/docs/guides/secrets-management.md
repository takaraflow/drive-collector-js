# Secrets Management System

This document describes the comprehensive secrets management system implemented for the Cloudflare Workers Load Balancer, inspired by the `drive-collector-js` architecture.

## Overview

The secrets management system provides a robust, extensible foundation for managing secrets from multiple providers (Infisical, Doppler) with automatic build-time injection and wrangler integration. The architecture follows a 3-layer inheritance pattern with event-driven updates and service orchestration.

## Architecture

### Layered Architecture

```
BaseSecretsProvider (Abstract Base)
    ↓
CloudSecretsProvider (Generic Cloud Implementation)
    ↓
InfisicalSecretsProvider (Infisical-Specific Implementation)
```

### Core Components

#### 1. BaseSecretsProvider
- **Location**: `src/services/secrets/BaseSecretsProvider.js`
- **Purpose**: Abstract foundation with EventEmitter capabilities
- **Features**:
  - Polling lifecycle management
  - Retry logic with exponential backoff
  - Change detection and event emission
  - Secrets state management

#### 2. CloudSecretsProvider
- **Location**: `src/services/secrets/CloudSecretsProvider.js`
- **Purpose**: Generic cloud provider implementation
- **Features**:
  - SHA256 hashing for efficient change detection
  - Response validation and format parsing
  - Secret filtering with include/exclude patterns
  - Metadata export and validation

#### 3. InfisicalSecretsProvider
- **Location**: `src/services/secrets/InfisicalSecretsProvider.js`
- **Purpose**: Infisical-specific implementation
- **Features**:
  - Dual authentication (Service Token + Machine Identity)
  - @infisical/sdk integration
  - Environment mapping
  - Secret CRUD operations

#### 4. SecretsConfigManager
- **Location**: `src/config/SecretsConfigManager.js`
- **Purpose**: Manifest-driven configuration management
- **Features**:
  - Service-to-secret mapping
  - Reinitialization strategies
  - Environment-specific configuration
  - Validation and security rules

#### 5. SecretsOrchestrator
- **Location**: `src/config/SecretsOrchestrator.js`
- **Purpose**: Build-time secret injection and wrangler integration
- **Features**:
  - Multi-provider support
  - File generation (secrets.json, .env.build, metadata)
  - Validation and error handling
  - Dry-run mode and cleanup

## Configuration

### Secrets Manifest

The `src/config/secrets-manifest.json` defines the complete configuration for services, environments, and validation rules.

#### Service Configuration

```json
{
  "services": {
    "cache": {
      "name": "Cache Service",
      "configKeys": ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
      "reinitStrategy": "reconnect",
      "dependencies": []
    }
  }
}
```

#### Reinitialization Strategies

- `destroy_initialize`: Full destroy/recreate cycle
- `lightweight_reconnect`: Reconnect without restart
- `reconfigure`: Update configuration only
- `reconnect`: Reestablish connections
- `restart`: Full service restart

#### Environment Configuration

```json
{
  "environments": {
    "prod": {
      "overrides": {
        "DEBUG_LOGS": "false"
      },
      "requiredSecrets": ["QSTASH_CURRENT_SIGNING_KEY", "AXIOM_TOKEN"]
    }
  }
}
```

## Usage

### Build-Time Integration

Use the enhanced build scripts to automatically inject secrets during deployment:

```bash
# Development environment
npm run deploy:dev

# Pre-production
npm run deploy:pre

# Production
npm run deploy:prod

# Enhanced build with secrets injection
npm run build:enhanced -- --env=prod

# Dry run to preview changes
npm run build:enhanced -- --env=prod --dry-run
```

### Programmatic Usage

```javascript
import { SecretsOrchestrator } from './src/config/SecretsOrchestrator.js';

const orchestrator = new SecretsOrchestrator({
    environment: 'prod',
    provider: 'infisical',
    providerConfig: {
        projectId: process.env.INFISICAL_PROJECT_ID,
        token: process.env.INFISICAL_TOKEN
    },
    validate: true,
    dryRun: false
});

const result = await orchestrator.executeInjection();
console.log(`Injected ${result.secrets.size} secrets`);
```

### Direct Provider Usage

```javascript
import { InfisicalSecretsProvider } from './src/services/secrets/InfisicalSecretsProvider.js';

const provider = new InfisicalSecretsProvider({
    projectId: 'your-project-id',
    environment: 'prod',
    auth: {
        token: 'your-service-token'
    }
});

await provider.initialize();
const secrets = provider.getAllSecrets();
```

## Environment Variables

### Required for Infisical Integration

- `INFISICAL_PROJECT_ID`: Infisical project ID
- `INFISICAL_TOKEN`: Service token for authentication
- `INFISICAL_SITE_URL`: (Optional) Custom Infisical site URL

### Build Configuration

- `USE_ORCHESTRATED_SECRETS`: Enable/disable enhanced secrets system (default: true)
- `NODE_ENV`: Target environment (dev/pre/prod)
- `DEPLOY_ENV`: Deployment environment override

### Existing Variables (Integrates with Current System)

- `QSTASH_CURRENT_SIGNING_KEY`: QStash signature verification
- `UPSTASH_REDIS_REST_URL`: Redis connection URL
- `UPSTASH_REDIS_REST_TOKEN`: Redis authentication token
- `AXIOM_TOKEN`: Axiom logging token
- `AXIOM_DATASET`: Axiom dataset name

## File Generation

### secrets.json
Generated for wrangler bulk upload:
```json
{
  "QSTASH_CURRENT_SIGNING_KEY": "value",
  "UPSTASH_REDIS_REST_URL": "value"
}
```

### .env.build
Generated for local development:
```bash
# Generated secrets for environment: prod
# Generated at: 2024-01-15T10:30:00.000Z

QSTASH_CURRENT_SIGNING_KEY="****ret-key"
UPSTASH_REDIS_REST_URL="redis://****@host:port"
```

### secrets-metadata.json
Build metadata and validation results:
```json
{
  "environment": "prod",
  "provider": "infisical",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "secretsCount": 6,
  "validation": {
    "valid": true,
    "errors": [],
    "warnings": []
  }
}
```

## Testing

### Unit Tests

```bash
# Run all tests
npm test

# Run secrets-specific tests
npm test -- secrets

# Run with coverage
npm run test:coverage -- secrets
```

### Test Coverage

- `BaseSecretsProvider.test.js`: Core functionality and event handling
- `SecretsConfigManager.test.js`: Configuration management and validation
- `SecretsOrchestrator.test.js`: Integration and file generation

## Security Features

### Protection
- Prevents override of critical infrastructure variables
- Environment-based access controls
- Secret masking in logs and outputs

### Validation
- Secret key format validation
- Value length and encoding checks
- Required secret verification per environment

### Auditing
- Complete build metadata generation
- Change tracking and logging
- Provider authentication status

## Migration from Legacy System

The enhanced system is backward compatible with the existing `deploy-with-secrets.js`. The system automatically:

1. **Attempts orchestrated injection** using Infisical
2. **Falls back to legacy method** if orchestration fails
3. **Maintains existing file formats** and deployment flow

### Migration Steps

1. Set up Infisical project and import existing secrets
2. Configure environment variables (INFISICAL_PROJECT_ID, INFISICAL_TOKEN)
3. Run `npm run deploy:dev -- --dry-run` to preview changes
4. Deploy to production when ready

## Extending the System

### Adding New Providers

1. Create provider class extending `CloudSecretsProvider`
2. Implement required abstract methods:
   - `authenticate()`
   - `fetchSecrets()`
   - `validateResponse()`
   - `parseSecrets()`

3. Register in `SecretsOrchestrator`:
```javascript
case 'your-provider':
    this.provider = new YourSecretsProvider(config);
    break;
```

### Adding New Services

Update `secrets-manifest.json`:
```json
{
  "services": {
    "your-service": {
      "name": "Your Service",
      "configKeys": ["YOUR_SECRET_KEY"],
      "reinitStrategy": "reconfigure",
      "dependencies": ["cache"]
    }
  }
}
```

### Custom Validation Rules

Extend validation in `secrets-manifest.json`:
```json
{
  "validation": {
    "secretKeys": {
      "pattern": "^[A-Z][A-Z0-9_]*$",
      "maxLength": 100
    },
    "customRules": {
      "your-rule": "validation-logic"
    }
  }
}
```

## Troubleshooting

### Common Issues

1. **Authentication Failures**
   - Verify INFISICAL_TOKEN and INFISICAL_PROJECT_ID
   - Check token permissions and project access

2. **Missing Required Secrets**
   - Review environment requirements in manifest
   - Verify secret names match exactly

3. **Build Failures**
   - Use `--dry-run` flag to preview changes
   - Check validation errors in build output

4. **File Generation Issues**
   - Ensure output directory is writable
   - Check file permissions and disk space

### Debug Mode

Enable detailed logging:
```bash
DEBUG_LOGS=true npm run build:enhanced -- --env=dev
```

### Fallback Mode

Disable orchestrated secrets to use legacy system:
```bash
USE_ORCHESTRATED_SECRETS=false npm run deploy:dev
```

## Future Enhancements

### Planned Features

1. **DopplerSecretsProvider**: Full Doppler integration
2. **Runtime Polling**: Automatic secret updates during operation
3. **Secret Rotation**: Automated key rotation support
4. **Advanced Masking**: Pattern-based secret masking
5. **Multi-Provider Failover**: Automatic provider switching

### Performance Optimizations

1. **Caching Layer**: In-memory secret caching
2. **Parallel Fetching**: Concurrent secret retrieval
3. **Incremental Updates**: Only update changed secrets
4. **Compression**: Compressed secret storage

## API Reference

### BaseSecretsProvider Methods

- `initialize()`: Initialize provider and fetch secrets
- `getSecret(key)`: Get individual secret value
- `getAllSecrets()`: Get all secrets as Map
- `refreshSecrets()`: Force refresh from provider
- `startPolling()`: Start automatic polling
- `stopPolling()`: Stop automatic polling
- `cleanup()`: Cleanup resources

### SecretsConfigManager Methods

- `getService(serviceId)`: Get service configuration
- `getServicesForSecret(secretKey)`: Get services using secret
- `getAffectedServices(changes)`: Get services affected by changes
- `validateConfiguration(env, secrets)`: Validate secrets for environment
- `maskSecret(key, value)`: Mask sensitive values

### SecretsOrchestrator Methods

- `executeInjection()`: Execute complete injection workflow
- `getStatus()`: Get orchestration status
- `cleanup()`: Cleanup resources and temporary files

---

This secrets management system provides a robust foundation for secure, scalable secret management in Cloudflare Workers deployments while maintaining backward compatibility and supporting future extensibility.