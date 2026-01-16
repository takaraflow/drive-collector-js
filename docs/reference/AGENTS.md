# LB Worker JS - Agent Development Guide

This file provides essential guidelines for agentic coding agents working in this Cloudflare Workers load balancer codebase.

## Build/Test/Lint Commands

### Development
```bash
npm run dev              # Local development (wrangler dev)
npm run dev:prod         # Remote development against production
npm run build            # Production build with esbuild
```

### Testing
```bash
npm test                 # Run all tests
npm run test:coverage   # Run with coverage
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests only
npm run test:fast        # 50% workers for faster execution
npm run test:optimized   # 100% workers full optimization
npm run test:watch       # Watch mode for development
```

### **Running Single Tests**
```bash
# Specific test file
npm test load-balancer-core.test.js

# Tests matching pattern
npm test -- --testNamePattern="specific test name"

# Coverage for specific file
npm run test:coverage -- load-balancer-core.test.js
```

### Deployment
```bash
npm run deploy:dev       # Deploy to development
npm run deploy:pre       # Deploy to pre-production
npm run deploy:prod      # Deploy to production
```

### Utility
```bash
npm run validate:manifest    # Validate manifest.json
npm run diagnose:axiom       # Check Axiom logging issues
```

## Code Style Guidelines

### Naming Conventions
- **Files**: PascalCase for classes (`CacheService.js`), camelCase for utilities (`configParser.js`)
- **Functions**: camelCase, descriptive (`getActiveInstances`, `verifyQStashSignature`)
- **Variables**: camelCase, `const` for immutable, `let` for mutable
- **Constants**: UPPER_SNAKE_CASE (`HEARTBEAT_TIMEOUT`, `ROUND_ROBIN_KEY`)
- **Classes**: PascalCase (`CacheService`, `RedisTLSService`)
- **Environment**: UPPER_SNAKE_CASE (`ADMIN_API_TOKEN`, `CACHE_PROVIDERS`)

### Import Organization
```javascript
// 1. External dependencies
import { trace } from '@opentelemetry/api';
import { Receiver } from '@upstash/qstash';

// 2. Internal modules (relative)
import { logger } from './logger.js';
import { CacheService } from './cache/CacheService.js';
import { parseCacheConfig } from '../utils/configParser.js';
```

### Type Patterns (JSDoc)
```javascript
/**
 * @typedef {Object} LoggerContext
 * @property {string} env - Environment (prod, dev, pre, test)
 * @property {Array<Object>} [logBuffer] - Current request's log buffer
 */

/**
 * @param {string} key - Cache key
 * @param {'json'|'string'|'buffer'} type - Return type
 * @returns {Promise<any|null>}
 */
async get(key, type = 'json') {
  // Implementation
}
```

## Error Handling Patterns

### Consistent Error Structure
```javascript
try {
  const result = await operation();
  return result;
} catch (error) {
  await log.error('Operation failed', { 
    error: error.message, 
    context: additionalData 
  });
  throw new Error(`Operation failed: ${error.message}`);
}
```

### HTTP Response Patterns
```javascript
// Validation errors (400)
if (!token) {
  throw new Error('ADMIN_API_TOKEN 未配置');
}

// Authentication errors (401)
if (providedToken !== token) {
  throw new Error('无效的 API Token');
}

// Service unavailable (503)
if (activeInstances.length === 0) {
  return new Response(JSON.stringify({
    error: 'No active instances available'
  }), { status: 503 });
}

// Internal errors (500) with logging
catch (error) {
  await log.error('Internal error', { 
    error: error.message, 
    stack: error.stack 
  });
  return new Response(JSON.stringify({
    error: 'Internal Server Error'
  }), { status: 500 });
}
```

## Testing Guidelines

### Test Structure
```javascript
import { vi, describe, expect, it, beforeEach, afterEach } from 'vitest';

// Mock external dependencies
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    child: vi.fn().mockReturnThis(),
  },
  VERSION: 'test',
}));

describe('ComponentName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should behave correctly', async () => {
    // Test implementation
  });
});
```

### Mock Patterns
- Mock external modules in `__tests__/mocks/`
- Use `vi.useFakeTimers()` for time-dependent tests
- Mock fetch with `vi.fn()`
- Clear mocks in `beforeEach()`

## Architecture Patterns

### Cache Abstraction Layer
```javascript
class CacheService {
  async get(key, type = 'json') {
    try {
      return await this.primaryProvider.get(key, type);
    } catch (error) {
      await this._handleProviderFailure(error);
      if (this.isFailoverMode && this.fallbackProvider) {
        return await this.fallbackProvider.get(key, type);
      }
      return null;
    }
  }
}
```

### Load Balancing Strategy
- **Round Robin**: Default distribution
- **Lock-based Routing**: For stateful operations
- **Health Checks**: Instance validation
- **Failover**: Automatic retry with remaining instances

### Logging Standards
- **Structured Logging**: JSON format with consistent fields
- **Context Preservation**: Request-scoped log buffering
- **Multiple Sinks**: Console (dev) and Axiom (production)
- **OpenTelemetry**: Distributed tracing integration

## Development Workflow

### When Adding Features
1. Follow layered architecture (handler → service → cache)
2. Implement comprehensive structured logging
3. Add corresponding tests following existing patterns
4. Update documentation if adding new APIs
5. Consider environment-specific behavior

### When Modifying Cache Layer
1. Maintain interface compatibility in `interfaces.js`
2. Test with multiple providers (KV, Redis)
3. Handle connection failures gracefully
4. Update CacheService if adding new providers

### When Adding APIs
1. Define contracts in `docs/CONTRACT.md`
2. Add authentication if needed
3. Implement proper error responses
4. Add integration tests
5. Update admin API docs if applicable

## Performance Considerations

- **Minimize blocking operations** in request handlers
- **Use `ctx.waitUntil()`** for background tasks
- **Implement proper cache TTLs**
- **Log sampling** for high-volume operations
- **Connection pooling** for external services

## Key Files to Understand

- `src/index.js` - Main request handler and routing
- `src/cache/CacheService.js` - Cache abstraction layer
- `src/logger.js` - Centralized logging system
- `docs/CONTRACT.md` - API contracts between services
- `__tests__/vitest.setup.js` - Test configuration

## Environment-Specific Behavior

- **Development**: Console logging, local cache
- **Production**: Axiom logging, distributed cache
- **Testing**: Mocked dependencies, in-memory cache

Always verify your changes work across all environments before committing.