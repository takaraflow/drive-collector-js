# AGENTS.md

## Repository Development Guidelines

### 🏗️ Build & Test Commands

#### Single Test Execution
```bash
# Run specific test file
npx vitest run path/to/test.test.js

# Run specific test with coverage
npx vitest run path/to/test.test.js --coverage

# Run tests matching pattern
npx vitest run --grep "test description"

# Run tests in watch mode for development
npm run test:watch

# Performance-focused test run
npm run test:optimized
```

#### Code Quality Checks
```bash
# Linting (if ESLint is configured)
npx eslint src/**/*.js

# Type checking (if TypeScript is configured)
npx tsc --noEmit

# Full test suite with coverage
npm run test:coverage

# Performance benchmarking
npm run test:perf
```

### 📋 Code Style Guidelines

#### Import Conventions
- Use ES6 imports: `import { named } from 'module'`
- Place imports at the top of the file
- Group related imports together
- Use absolute imports for test mocks to avoid resolution issues

#### Naming Conventions
- **Files**: kebabab-case for regular files (e.g., `userService.js`)
- **Tests**: `*.test.js` or `*.spec.js` suffix
- **Variables**: camelCase for regular variables, UPPER_CASE for constants
- **Functions**: camelCase for regular functions, PascalCase for classes
- **Test Descriptions**: Descriptive, start with "should" for behavior tests

#### TypeScript/JSDoc Patterns
```javascript
/**
 * UserService handles user management operations
 * @class
 */
class UserService {
  /**
   * Creates a new user
   * @param {Object} userData - User data to create
   * @returns {Promise<User>} - Created user instance
   */
  async createUser(userData) {
    // Implementation
  }
}
```

#### Error Handling Patterns
```javascript
// Always handle errors explicitly
try {
  await riskyOperation();
} catch (error) {
  // Log error with context
  logger.error('Operation failed', { userId, error: error.message });
  
  // Either rethrow with context or handle gracefully
  throw new Error(`Operation failed for user ${userId}: ${error.message}`);
}

// Never use silent catches
catch (error) {
  // ❌ Bad - swallows errors
  console.error(error);
}

// ✅ Good - handle or rethrow
catch (error) {
  handleError(error); // Centralized error handling
  throw error;
}
```

#### Mock Patterns for Testing
```javascript
// Mock external dependencies
vi.mock('external-package', () => ({
  default: vi.fn(),
  specificFunction: vi.fn()
}));

// Mock internal modules
vi.mock('../../src/module.js', () => ({
  default: vi.fn(),
  exportFunction: vi.fn()
}));

// Reset mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// Create deterministic mocks
const mockUser = {
  id: 'user-123',
  name: 'Test User',
  createdAt: new Date('2024-01-01')
};
```

#### Async/Await Patterns
```javascript
// Always await promises
const result = await asyncOperation();

// Never mix callbacks with async/await in tests
// ❌ Bad
async function test() {
  await operation1();
  operation2(() => {
    // This creates race conditions
  });
}

// ✅ Good
async function test() {
  await operation1();
  await operation2();
  // Both complete before moving on
}

// Handle concurrent operations properly
const results = await Promise.all([
  operation1(),
  operation2(),
  operation3()
]);
```

### 🧪 Testing Guidelines

#### Test Structure
```javascript
describe('ServiceName - Feature', () => {
  let service;

  beforeEach(() => {
    // Fresh instance per test
    service = new Service();
  });

  afterEach(() => {
    // Cleanup if needed
    if (service && typeof service.cleanup === 'function') {
      service.cleanup();
    }
  });

  test('should do expected behavior', async () => {
    // Act
    const result = await service.method();
    
    // Assert
    expect(result).toEqual(expectedResult);
    expect(service.method).toHaveBeenCalledTimes(1);
  });
});
```

#### Performance Constraints
- **Single test case**: ≤ 15ms execution time
- **Single test file**: ≤ 300ms total execution time
- **No real I/O**: All external dependencies must be mocked
- **No real timers**: Use `vi.useFakeTimers()` when testing time-based logic
- **Deterministic**: No random values, use fixed seeds or mocks

#### Mock Strategy
```javascript
// Mock at module level, before imports
vi.mock('../../src/dependency.js', () => ({
  default: vi.fn()
}));

// Cache expensive operations
const mockService = new MockService();
beforeAll(() => {
  // Initialize once for all tests
  mockService.setup();
});
```

### ⚡ Performance Optimization

#### File Organization
```
src/
├── services/          # Business logic services
├── repositories/       # Data access layer
├── utils/            # Utility functions
├── modules/           # Feature modules
└── config/           # Configuration
```

#### Dependency Management
- Keep dependencies in `dependencies` for production code
- Move development-only dependencies to `devDependencies`
- Use exact versions in package.json
- Regular dependency updates for security patches

#### Bundle Optimization
- Use dynamic imports for large, rarely-used modules
- Implement lazy loading where appropriate
- Avoid circular dependencies
- Use tree-shaking friendly import/export patterns

### 🔒 Security Guidelines

#### Environment Variables
```javascript
// Never hardcode sensitive values
// ❌ Bad
const apiKey = 'hardcoded-secret-key';

// ✅ Good
const apiKey = process.env.API_KEY;
// Or use dependency injection
function createService(apiKey = process.env.API_KEY) {
  return new Service(apiKey);
}
```

#### Input Validation
```javascript
// Always validate inputs at boundaries
function processUserInput(userData) {
  // Validate required fields
  if (!userData.email || !userData.name) {
    throw new Error('Email and name are required');
  }
  
  // Sanitize inputs
  const sanitizedEmail = userData.email.toLowerCase().trim();
  
  // Business logic
  return processUserData(sanitizedEmail);
}
```

### 📦 Project Structure

#### Module Organization
```
drive-collector-js/
├── src/                    # Source code
│   ├── services/            # Business logic services
│   │   ├── telegram.js      # Telegram bot service
│   │   ├── rclone.js        # Rclone wrapper service
│   │   ├── cache/          # Cache implementations
│   │   └── queue/          # Queue implementations
│   ├── repositories/         # Data access layer
│   │   ├── TaskRepository.js
│   │   ├── DriveRepository.js
│   │   └── SettingsRepository.js
│   ├── modules/            # Feature modules
│   │   ├── SessionManager.js
│   │   ├── DriveConfigFlow.js
│   │   └── AuthGuard.js
│   ├── utils/              # Utility functions
│   │   ├── common.js
│   │   ├── limiter.js
│   │   └── serializer.js
│   └── config/            # Configuration management
├── __tests__/              # Test suite
│   ├── services/           # Service tests
│   ├── repositories/       # Repository tests
│   ├── modules/            # Module tests
│   ├── integration/        # Integration tests
│   └── utils/             # Utility tests
├── scripts/               # Build and utility scripts
├── locales/               # Internationalization
└── docs/                  # Documentation
```

### 🎯 Environment Configuration

#### Development Environment Setup
```bash
# Install dependencies
npm install

# Set up environment file
cp .env.example .env.test

# Run tests
npm run test:watch

# Development mode
npm run dev
```

#### Testing Environment Setup
```bash
# Run unit tests only
npm run test:unit

# Run integration tests
npm run test:integration

# Run with coverage
npm run test:coverage

# Performance focused tests
npm run test:optimized
```

### 📊 Monitoring & Metrics

#### Test Performance Monitoring
```bash
# Run performance benchmark
npm run test:perf

# Generate performance report
npm run test:perf:report

# Run optimized test suite
npm run test:full-optimized
```

#### Coverage Requirements
- Target > 80% code coverage
- All critical paths must have tests
- Maintain test quality: no flaky tests
- Keep test execution time within performance budgets

### 🚀 CI/CD Integration

#### Build Pipeline
```bash
# Install dependencies
npm ci

# Run linting
npm run lint  # if configured

# Run tests with coverage
npm run test:coverage

# Build application
npm run build  # if configured
```

#### Deployment Pipeline
```bash
# Validate production dependencies
npm run test:prod-deps

# Run full test suite
npm run test

# Deploy to production
npm run deploy
```

---

## 📖 Additional Resources

### Framework-Specific Guidelines
- **Vitest**: Follow official Vitest testing patterns
- **ESLint**: Follow recommended rules for Node.js projects
- **Prettier**: Consistent code formatting
- **Husky**: Git hooks for pre-commit validation

### Key Files to Reference
- `package.json` - Project configuration and scripts
- `vitest.config.js` - Test configuration
- `.clinerules` - Development principles and constraints
- `src/config/index.js` - Application configuration management

---

*This document should be updated regularly to reflect current best practices and project-specific requirements.*