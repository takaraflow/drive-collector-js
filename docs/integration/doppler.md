# Doppler Secrets Integration Guide

This guide explains how to use Doppler as the secrets provider for the load balancer worker.

## 🔧 Configuration

### 1. Install Doppler CLI

```bash
# Install Doppler CLI
npm install -g @dopplerhq/cli

# Login to Doppler
doppler login
```

### 2. Environment Variables

Copy `.env.doppler.example` to `.env.doppler` and configure:

```bash
# Required Configuration
SECRETS_PROVIDER=doppler
DOPPLER_PROJECT=your-project-name
DOPPLER_TOKEN=dp.st.dev.xxxxxx

# Environment
NODE_ENV=dev  # dev, staging, prod
```

### 3. Authentication Methods

#### Method 1: Service Token (Recommended)
```bash
DOPPLER_TOKEN=dp.st.dev.xxxxxx
```

#### Method 2: API Token
```bash
DOPPLER_API_TOKEN=your-api-token
```

#### Method 3: Service Account Token
```bash
DOPPLER_SERVICE_ACCOUNT_TOKEN=dp.sa.xxxxxx
```

#### Method 4: API Key (Legacy)
```bash
DOPPLER_API_KEY=your-api-key
```

## 🚀 Usage

### Development

```bash
# Use Doppler for development
SECRETS_PROVIDER=doppler npm run dev:dev
```

### Deployment

```bash
# Deploy with Doppler secrets
SECRETS_PROVIDER=doppler npm run deploy:prod

# Preview what secrets will be injected
SECRETS_PROVIDER=doppler npm run build:enhanced -- --env=prod --dry-run
```

### GHA Integration

In your GitHub Actions workflow:

```yaml
- name: Deploy with Doppler Secrets
  env:
    SECRETS_PROVIDER: doppler
    DOPPLER_PROJECT: ${{ secrets.DOPPLER_PROJECT }}
    DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}
  run: npm run deploy:prod
```

## 📁 Environment Variable Mapping

| Environment Variable | Doppler Config | Description |
|-------------------|----------------|-------------|
| `NODE_ENV=dev` | `dev` | Development environment |
| `NODE_ENV=staging` | `staging` | Staging environment |
| `NODE_ENV=prod` | `prod` | Production environment |
| `NODE_ENV=pre` | `staging` | Pre-production environment |

## 🔒 Security Features

### Token Priority
The system uses this priority order for authentication:
1. Service Token (`DOPPLER_TOKEN`)
2. API Token (`DOPPLER_API_TOKEN`)
3. Service Account Token (`DOPPLER_SERVICE_ACCOUNT_TOKEN`)
4. API Key (`DOPPLER_API_KEY`)

### Secret Filtering
```bash
# Include only specific secrets
DOPPLER_INCLUDE_SECRETS=QSTASH_KEY,REDIS_TOKEN

# Exclude specific secrets
DOPPLER_EXCLUDE_SECRETS=DEBUG_KEY,TEST_SECRET
```

## 🧪 Testing

### Local Testing with Doppler

```bash
# Set up Doppler environment for testing
export SECRETS_PROVIDER=doppler
export DOPPLER_PROJECT=your-test-project
export DOPPLER_TOKEN=dp.st.dev.xxxxxx

# Run the build process
npm run build:enhanced -- --env=dev --dry-run
```

### Unit Tests

The system includes comprehensive tests for Doppler integration:

```bash
# Run all tests including Doppler
npm test

# Run specific provider tests
npm test -- --testNamePattern="Doppler"
```

## 🔄 Provider Comparison

| Feature | Infisical | Doppler |
|---------|-----------|---------|
| Service Token | ✅ | ✅ |
| Machine Identity | ✅ | ❌ |
| API Token | ❌ | ✅ |
| Service Account | ❌ | ✅ |
| Multi-Project | ✅ | ✅ |
| Audit Logs | ✅ | ✅ |
| Secrets Versioning | ✅ | ✅ |

## 📋 Doppler Project Setup

### 1. Create Doppler Project
```bash
doppler projects create your-project-name
```

### 2. Configure Environments
```bash
# Create environments
doppler configs create dev
doppler configs create staging
doppler configs create prod
```

### 3. Add Secrets
```bash
# Add secrets to development config
doppler secrets set QSTASH_CURRENT_SIGNING_KEY --config=dev
doppler secrets set REDIS_URL --config=dev
doppler secrets set AXIOM_TOKEN --config=dev
```

### 4. Import Existing Secrets
If you have existing secrets in a `.env` file:

```bash
# Import from .env file
doppler secrets import --config=dev .env.production
```

## 🐛 Troubleshooting

### Common Issues

#### 1. Authentication Failed
```bash
Error: Doppler authentication failed: Invalid token
```
**Solution**: Verify your Doppler token is valid and has proper permissions.

#### 2. Project Not Found
```bash
Error: Failed to fetch secrets from Doppler: Project not found
```
**Solution**: Ensure `DOPPLER_PROJECT` matches your Doppler project name exactly.

#### 3. No Access to Config
```bash
Error: Failed to fetch secrets from Doppler: Access denied
```
**Solution**: Verify your service token has access to the specified environment/config.

### Debug Mode

Enable debug logging to troubleshoot issues:

```bash
DEBUG_LOGS=true SECRETS_PROVIDER=doppler npm run build:enhanced -- --env=dev
```

### Fallback to Infisical

If Doppler fails, the system will automatically fall back to Infisical if configured:

```bash
# Configure both providers (Doppler prioritized)
SECRETS_PROVIDER=doppler
DOPPLER_PROJECT=project-name
DOPPLER_TOKEN=dp.st.dev.xxxxxx
# Fallback configuration
INFISICAL_PROJECT_ID=backup-project
INFISICAL_TOKEN=backup-token
```

## 📊 Monitoring

### Doppler Audit Logs

Monitor secret access through Doppler dashboard:
1. Go to your Doppler project
2. Click "Audit Logs"
3. Filter by date and event type

### Build Metadata

The system generates `secrets-metadata.json` with:

```json
{
  "provider": "doppler",
  "project": "your-project-name",
  "config": "dev",
  "timestamp": "2024-01-16T20:30:00.000Z",
  "secretsCount": 6,
  "providerMetadata": {
    "authMethod": "service-token",
    "apiHost": "https://api.doppler.com"
  }
}
```

## 🔄 Migration from Infisical

### Step 1: Set up Doppler Project
```bash
# Create new Doppler project
doppler projects create lb-worker-prod

# Create environments
doppler configs create dev
doppler configs create prod
```

### Step 2: Export Infisical Secrets
```bash
# Export from Infisical
infisical export --env=prod --format=json > infisical-secrets.json
```

### Step 3: Import to Doppler
```bash
# Import to Doppler production
doppler secrets import --config=prod infisical-secrets.json
```

### Step 4: Update Configuration
```bash
# Switch to Doppler
sed -i 's/SECRETS_PROVIDER=infisical/SECRETS_PROVIDER=doppler/' .env
sed -i 's/INFISICAL_PROJECT_ID/DOPPLER_PROJECT/' .env
sed -i 's/INFISICAL_TOKEN/DOPPLER_TOKEN/' .env
```

## 🎯 Best Practices

### 1. Environment Separation
- Use separate Doppler configs for dev/staging/prod
- Never use production secrets in development

### 2. Token Security
- Use service tokens for CI/CD
- Rotate tokens regularly
- Never commit tokens to version control

### 3. Access Control
- Use service accounts for automated systems
- Limit access to specific configs
- Enable audit logging

### 4. Backup Strategy
- Configure both Doppler and Infisical as fallback
- Regular backup of critical secrets
- Test restoration procedures

---

For more information about Doppler, visit: [https://www.doppler.com](https://www.doppler.com)