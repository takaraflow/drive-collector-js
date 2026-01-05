# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [0.12.0](https://github.com/YoungSx/lb-worker-js/compare/v0.11.0...v0.12.0) (2026-01-05)


### 🐛 Bug Fixes

* adds path parameter to Infisical export command ([9a2f0c0](https://github.com/YoungSx/lb-worker-js/commit/9a2f0c0d833cf1a38ad2662e1cd5edf754c75c66))
* changes environment variable validation to be informational only ([83d55e4](https://github.com/YoungSx/lb-worker-js/commit/83d55e4c52931e47d9bc978fe23d015dccc91ce8))
* enhances environment variable validation and masking ([4bc99a9](https://github.com/YoungSx/lb-worker-js/commit/4bc99a987e2cdabc478d8cf5272db665108de2b1))
* enhances Infisical integration and improves secret management ([3b4298f](https://github.com/YoungSx/lb-worker-js/commit/3b4298f29c1056f3227012d9d4b0c03c6e0daf61))
* improves Infisical secret fetching with dynamic delimiter ([68caf0e](https://github.com/YoungSx/lb-worker-js/commit/68caf0e8695c7811ec4325ff686ee033290017dd))
* improves Infisical secret management and validation ([c44ab7c](https://github.com/YoungSx/lb-worker-js/commit/c44ab7ce7f74fc1ab5b7a2b04c8546ef68762406))
* improves Infisical secret retrieval with validation ([2bff99f](https://github.com/YoungSx/lb-worker-js/commit/2bff99f5363b491e28899acb59984704dcd6cfe3))
* improves Infisical secrets handling with filtering and masking ([8982196](https://github.com/YoungSx/lb-worker-js/commit/898219655cd3285b7f72cca281c64caddb3826cd))
* improves manifest.json validation and error handling ([785bdd8](https://github.com/YoungSx/lb-worker-js/commit/785bdd86373d38e8dce0efe4fc1282f9d84bb10b))
* improves quote stripping logic for environment variables ([868cb93](https://github.com/YoungSx/lb-worker-js/commit/868cb93d8143469d4008420c426a2871e3776484))
* improves sensitive data handling in deployment workflow ([4f19f7f](https://github.com/YoungSx/lb-worker-js/commit/4f19f7f0df8f3c32a26fbfb8226f75b36c1ca0f5))
* moves ajv to production dependencies ([e095448](https://github.com/YoungSx/lb-worker-js/commit/e0954481040de37eb4c7be945cc0bb67a0ac9736))
* remove debug message ([82f35ac](https://github.com/YoungSx/lb-worker-js/commit/82f35acbde8113986c3d34b82773575bbdc387ad))
* removes redundant secret masking step ([759891a](https://github.com/YoungSx/lb-worker-js/commit/759891a26ace93ebc17bac0b5da968769909c679))
* restricts secret validation to required environment variables only ([8528cc7](https://github.com/YoungSx/lb-worker-js/commit/8528cc74a2097c2ae12fef4d0f5606d6ef7dcb6b))
* simplifies secret injection workflow ([150391f](https://github.com/YoungSx/lb-worker-js/commit/150391ff662722969a40e170f1c6880a95f12aae))
* test CI ([9714f8d](https://github.com/YoungSx/lb-worker-js/commit/9714f8d0dd37e05ab5a802c0f1b009b9e9ae0e88))
* updates dependencies and removes redundant build tool installation ([0ab6437](https://github.com/YoungSx/lb-worker-js/commit/0ab643700c3b2b17fe8253a69e66ce239b48fa94))
* updates environment handling for Infisical integration ([13ac759](https://github.com/YoungSx/lb-worker-js/commit/13ac759317cea208118c065db2a6f23c19a2965f))
* updates environment variable names to be more concise ([0855613](https://github.com/YoungSx/lb-worker-js/commit/08556139683af0bc50bc5f324d827fa5e82ba9fa))
* updates environment variable naming to use NODE_ENV ([f7116b0](https://github.com/YoungSx/lb-worker-js/commit/f7116b0c8cb9cedcb1bb3703a7f4a13bbd343bdd))
* updates esbuild setup for better reliability ([a736829](https://github.com/YoungSx/lb-worker-js/commit/a73682982eddb159361fc26c135ac4707740b11d))
* updates Infisical configuration parsing to handle array response ([c599316](https://github.com/YoungSx/lb-worker-js/commit/c599316f5c1ba2c9bc7acb66860bfd66519c55a1))
* updates NODE_ENV value and skips masking for sensitive keys ([786c3c5](https://github.com/YoungSx/lb-worker-js/commit/786c3c5ec74f7d03f2e4f4b5ad5470c391ab2c79))


### 🔧 Maintenance

* improves deployment workflow with secret management ([ff66d21](https://github.com/YoungSx/lb-worker-js/commit/ff66d2174c6364ea4960387169d860da301e6845))

## [0.11.0](https://github.com/YoungSx/lb-worker-js/compare/v0.10.2...v0.11.0) (2026-01-04)


### 🔧 Maintenance

* improve Redis TLS configuration and health checks ([0541f63](https://github.com/YoungSx/lb-worker-js/commit/0541f632c80a868a130e972c08e91a03cb150fa5))

### [0.10.2](https://github.com/YoungSx/lb-worker-js/compare/v0.10.1...v0.10.2) (2026-01-04)


### 🐛 Bug Fixes

* enhances release process and Redis TLS health checks ([76fd8f1](https://github.com/YoungSx/lb-worker-js/commit/76fd8f1964a3056f90f3f7c33089a024c61c866b))
* refactor: migrate from Redis TLS to generic Redis TLS ([commit-hash](https://github.com/YoungSx/lb-worker-js/commit/commit-hash))

### [0.10.1](https://github.com/YoungSx/lb-worker-js/compare/v0.10.0...v0.10.1) (2026-01-04)


### ✨ Features

* standardizes environment configuration and build process ([2ddb261](https://github.com/YoungSx/lb-worker-js/commit/2ddb261bb13088cfc3859f2a38c3178966173813))


### ✅ Testing

* improves environment variable handling and testing ([72460dc](https://github.com/YoungSx/lb-worker-js/commit/72460dce14469c3e26f597f1776a585cb04d5168))

## [0.10.0](https://github.com/YoungSx/lb-worker-js/compare/v0.9.3...v0.10.0) (2026-01-04)


### 🐛 Bug Fixes

* adds fallback for CLOUDFLARE_ACCOUNT_ID from .act.secrets in local dev ([e722833](https://github.com/YoungSx/lb-worker-js/commit/e722833bd0ebe5d3c03c33a181c6e81fe20526c2))
* adds newline check for private key validation ([e88a64b](https://github.com/YoungSx/lb-worker-js/commit/e88a64b2e3c3af4ef7eb5934d083883ec80fc3da))
* enables explicit Cloudflare API token and account ID propagation ([56ecc0a](https://github.com/YoungSx/lb-worker-js/commit/56ecc0a9a00329baf9f6e3504f2d1294675f3408))
* enhance log redaction to prevent sensitive info leakage ([6d804c0](https://github.com/YoungSx/lb-worker-js/commit/6d804c019acaad727d13ee8da70e287c74c9eca5))
* improves Infisical integration and error handling in deployment workflow ([1af4556](https://github.com/YoungSx/lb-worker-js/commit/1af4556af4202babdff232f2c71532404f13b996))
* improves secret management and fallback handling in deployment workflow ([aa90c8c](https://github.com/YoungSx/lb-worker-js/commit/aa90c8c15d5e63db57cfc248f9ad3baa7bba0561))
* removes redundant environment variable handling in wrangler command generation ([deb3c3f](https://github.com/YoungSx/lb-worker-js/commit/deb3c3fdf3b2c4187a37f93bf0b8a2555256c5f4))
* updates Cloudflare-related environment variables for consistency ([913d9ff](https://github.com/YoungSx/lb-worker-js/commit/913d9ff4b237acf83b1e1f7969ab2e1ec62d2e2d))


### 🔧 Maintenance

* make secret masking dynamic based on manifest.json ([271d571](https://github.com/YoungSx/lb-worker-js/commit/271d571bd108cca5b67aa07860f8d471367a91aa))


### ✨ Features

* adds robust log sanitization and size management for Axiom integration ([c7aafdc](https://github.com/YoungSx/lb-worker-js/commit/c7aafdce1d1ec37c5d3f68442345f0a16afe894a))

### [0.9.3](https://github.com/YoungSx/lb-worker-js/compare/v0.9.2...v0.9.3) (2026-01-04)


### ✨ Features

* add local GHA simulation support and update dependencies ([a80dec0](https://github.com/YoungSx/lb-worker-js/commit/a80dec0bca1d085a8ae9c09e9c4488ddfc6f5116))


### 🔧 Maintenance

* build logic ([973703c](https://github.com/YoungSx/lb-worker-js/commit/973703cebece36ddfd8cf2fd29a7e0535359a152))


### 🐛 Bug Fixes

* enhances test assertions with proper value quoting ([88dabce](https://github.com/YoungSx/lb-worker-js/commit/88dabce0b4e34e5ef384226cbb93e2917e394b5f))
* improves deployment security and reliability ([23eb584](https://github.com/YoungSx/lb-worker-js/commit/23eb584e073422f0819748e00cae1f86a463a6a1))
* improves sensitive data handling in deployment scripts ([c34c3fd](https://github.com/YoungSx/lb-worker-js/commit/c34c3fddff03274c126f2fe0697a6ac58cce1423))
* updates environment variable naming to use CF_ prefix ([f16ec29](https://github.com/YoungSx/lb-worker-js/commit/f16ec2949b5fb946ca11e37fcb446562bd1c4395))
* updates sensitive data redaction patterns ([26a1c40](https://github.com/YoungSx/lb-worker-js/commit/26a1c404442fdfce12706cbaffd8acfe9c0ec699))

### [0.9.2](https://github.com/YoungSx/lb-worker-js/compare/v0.9.1...v0.9.2) (2026-01-03)


### 🐛 Bug Fixes

* improves environment variable handling logic ([37663bc](https://github.com/YoungSx/lb-worker-js/commit/37663bcfaa282063caa371fabec8dbe82e4d5c48))
* improves environment variable parsing and security ([b1c8e38](https://github.com/YoungSx/lb-worker-js/commit/b1c8e386fc75b6de2e018918887213e79d0becae))


### 📝 Documentation

* removes deprecated R2 and legacy Redis configurations ([e849fde](https://github.com/YoungSx/lb-worker-js/commit/e849fde4109653fd58eeebcaae9a786247e863d7))

### [0.9.1](https://github.com/YoungSx/lb-worker-js/compare/v0.9.0...v0.9.1) (2026-01-03)


### 🐛 Bug Fixes

* remove useless code ([b32f67b](https://github.com/YoungSx/lb-worker-js/commit/b32f67b5e7452d68f5ec1fdde7b0bb7be20657f6))
* removes quotes from environment variable values ([51decaf](https://github.com/YoungSx/lb-worker-js/commit/51decaf1a6772c98ed54a3f423613a950f0d522f))

## [0.9.0](https://github.com/YoungSx/lb-worker-js/compare/v0.8.1...v0.9.0) (2026-01-03)


### 🔧 Maintenance

* **ci:** integrate Infisical for centralized secret management ([e43a050](https://github.com/YoungSx/lb-worker-js/commit/e43a050cd8211ac9287f15b43a1dc0021505cc7c))
* **ci:** integrate Infisical for centralized secret management ([5b1bc3a](https://github.com/YoungSx/lb-worker-js/commit/5b1bc3ab67f0e8249e45ae8538baa73136849b10))
* updates workflow to trigger on all branches ([10e7ad9](https://github.com/YoungSx/lb-worker-js/commit/10e7ad955a727ce080405f77210c96b6a9846da2))


### 🐛 Bug Fixes

* updates Infisical CLI installation URL ([12510d1](https://github.com/YoungSx/lb-worker-js/commit/12510d1265110be8bd1721b964a529dc9933c833))
* updates variable escaping to use double quotes ([1d0c342](https://github.com/YoungSx/lb-worker-js/commit/1d0c342d181c52324d4982261cc5a61db23d25f5))
* updates variable escaping to use single quotes ([f3b397f](https://github.com/YoungSx/lb-worker-js/commit/f3b397f3a682b2b65bcdce99f1c195296cab9935))

### [0.8.1](https://github.com/YoungSx/lb-worker-js/compare/v0.8.0...v0.8.1) (2026-01-02)


### 🐛 Bug Fixes

* 添加RequestInitializerDict错误分类到日志系统 ([90de0b7](https://github.com/YoungSx/lb-worker-js/commit/90de0b7309084221bef29ff17acab6ba4de2f543))
* enhances logging with OpenTelemetry span integration ([222d3c0](https://github.com/YoungSx/lb-worker-js/commit/222d3c00c618782bf085a50ad24e3790e24f8f97))
* improve OpenTelemetry span context handling in logger ([9232249](https://github.com/YoungSx/lb-worker-js/commit/923224940b4187332404cd7653983f8685358e05))


### 🔧 Maintenance

* replaces Axiom SDK with direct HTTP API calls ([2cc4bd6](https://github.com/YoungSx/lb-worker-js/commit/2cc4bd6d6f110b619600c08a4244881ee8e992dd))

## [0.8.0](https://github.com/YoungSx/lb-worker-js/compare/v0.7.10...v0.8.0) (2026-01-02)


### ✨ Features

* implement pino-based logging system ([2757dd1](https://github.com/YoungSx/lb-worker-js/commit/2757dd11a8f37c9032feb219333a9784b15b8016))

### [0.7.10](https://github.com/YoungSx/lb-worker-js/compare/v0.7.9...v0.7.10) (2026-01-02)


### ✨ Features

* add debug logging for request flow and axiom diagnostics ([79f26e9](https://github.com/YoungSx/lb-worker-js/commit/79f26e9fd1a073b26b5f717fd36b8aa8a46b13fc))

### [0.7.9](https://github.com/YoungSx/lb-worker-js/compare/v0.7.8...v0.7.9) (2026-01-02)


### ✅ Testing

* hard code log test ([e51114b](https://github.com/YoungSx/lb-worker-js/commit/e51114b146036a68f8a1ceac3c6e4e50cf92672b))


### 🐛 Bug Fixes

* add context object to handleRequest calls in tests ([5affe47](https://github.com/YoungSx/lb-worker-js/commit/5affe4741646ae5a73582fb0ca0a36c1af827dc5))
* logger ([12f761b](https://github.com/YoungSx/lb-worker-js/commit/12f761b9774d4a41486b68efd2c241dbf0e79e44))

### [0.7.8](https://github.com/YoungSx/lb-worker-js/compare/v0.7.7...v0.7.8) (2026-01-02)


### 🐛 Bug Fixes

* improves OTel span propagation in logger methods ([abb8b38](https://github.com/YoungSx/lb-worker-js/commit/abb8b3875d5161fc2cd60c1313c2569b6fbc4c23))

### [0.7.7](https://github.com/YoungSx/lb-worker-js/compare/v0.7.6...v0.7.7) (2026-01-02)


### 🐛 Bug Fixes

* correct Axiom exporter headers configuration by removing optional Org ID ([f0cfd47](https://github.com/YoungSx/lb-worker-js/commit/f0cfd47f76b50a52884528331c08c4ccf5637ad1))

### [0.7.6](https://github.com/YoungSx/lb-worker-js/compare/v0.7.5...v0.7.6) (2026-01-02)


### 🐛 Bug Fixes

* simplifies logging implementation and removes Axiom integration ([5ee1ca2](https://github.com/YoungSx/lb-worker-js/commit/5ee1ca2f5c21ee1f56ec4e132a434b686e58d453))

### [0.7.5](https://github.com/YoungSx/lb-worker-js/compare/v0.7.4...v0.7.5) (2026-01-02)


### 🐛 Bug Fixes

* dynamically parse GHA JSON for infra vars ([cbf1049](https://github.com/YoungSx/lb-worker-js/commit/cbf10495be75a96aad4a5ec5e42be1558a3757a7))
* improve Jest configuration and build process reliability ([b16f14f](https://github.com/YoungSx/lb-worker-js/commit/b16f14f4ed36326395851a61c90ece5f0e0d676a))
* replaces build.sh with cross-platform Node.js build logic ([6355e54](https://github.com/YoungSx/lb-worker-js/commit/6355e5415aea523dd1c94baa9b8f23b0ead03a0b))

### [0.7.4](https://github.com/YoungSx/lb-worker-js/compare/v0.7.3...v0.7.4) (2026-01-02)


### ✨ Features

* support full business vars in wrangler.toml during local build ([f1660ea](https://github.com/YoungSx/lb-worker-js/commit/f1660eabd170ade9b121b55103704ad607234364))


### 🐛 Bug Fixes

* improve test stability and deployment configuration ([6ae2793](https://github.com/YoungSx/lb-worker-js/commit/6ae2793194f22a2135e1d71e50e47fb038a47cc6))
* optimize generate-wrangler-vars.test.js performance, remove real IO and use fake timers/mocks ([ae9887b](https://github.com/YoungSx/lb-worker-js/commit/ae9887b42a39aa801960b00b0927fdeae98bd95b))
* updates WORKER_NAME default to use package.json name ([1dd73c7](https://github.com/YoungSx/lb-worker-js/commit/1dd73c7ff5b3c9b32812885839048295159ad37c))

### [0.7.3](https://github.com/YoungSx/lb-worker-js/compare/v0.7.2...v0.7.3) (2026-01-02)

### [0.7.2](https://github.com/YoungSx/lb-worker-js/compare/v0.7.1...v0.7.2) (2026-01-02)


### 🐛 Bug Fixes

* resolve process.env TS error in Worker context ([bdcc488](https://github.com/YoungSx/lb-worker-js/commit/bdcc488221e0a24172f83bd4f8a12a635658fcde))
* update @opentelemetry/api to exact version and add overrides ([2cce5ec](https://github.com/YoungSx/lb-worker-js/commit/2cce5ec30570422429080595dcdaa703fc2ac67d))
* updates build script to use dynamic version from package.json ([154982c](https://github.com/YoungSx/lb-worker-js/commit/154982c05f79503b80ec0600df6f63fc6524312b))

### [0.7.1](https://github.com/YoungSx/lb-worker-js/compare/v0.7.0...v0.7.1) (2026-01-02)


### 🐛 Bug Fixes

* updates Redis health check to use HTTP-based provider ([2e144c1](https://github.com/YoungSx/lb-worker-js/commit/2e144c1ef0472d360be4dd79349cd98378364f6d))

## [0.7.0](https://github.com/YoungSx/lb-worker-js/compare/v0.6.0...v0.7.0) (2026-01-02)


### 🔧 Maintenance

* implement Redis TCP client with enhanced reliability ([293f4b9](https://github.com/YoungSx/lb-worker-js/commit/293f4b91051c38b7c44afc2538d09e5de06fc1ed))


### 🐛 Bug Fixes

* improve Redis connection reliability and add TLS workaround ([223f28b](https://github.com/YoungSx/lb-worker-js/commit/223f28bbffe1e3ba35a1800ad92d704ab79887fd))
* improves Redis command retry logic and adds timeout handling ([b241d69](https://github.com/YoungSx/lb-worker-js/commit/b241d69b8e96559c68f8e88d8aa3d49785e48cc6))
* updates Redis client initialization with improved TLS configuration ([b1cdad1](https://github.com/YoungSx/lb-worker-js/commit/b1cdad1c68733fa4f96b99702c41a7d4cd58574c))

## [0.6.0](https://github.com/YoungSx/lb-worker-js/compare/v0.5.0...v0.6.0) (2026-01-01)


### ✨ Features

* **gha:** dynamic wrangler vars generation from manifest.json ([0341828](https://github.com/YoungSx/lb-worker-js/commit/0341828a4a6d50d6a36466f9ab7a193f45310e34))
* **gha:** ultimate dynamic secrets/vars import via GHA context JSON ([5659f9f](https://github.com/YoungSx/lb-worker-js/commit/5659f9fbf0a60492b1a0d0526ac490ff94c24d4b))


### 🐛 Bug Fixes

* **gha:** add REDIS_TLS_PASSWORD and REDIS_TLS_URL to deploy workflow ([c2a5d0c](https://github.com/YoungSx/lb-worker-js/commit/c2a5d0cf860f8dd307693289af7f9f2bd6620a86))
* **gha:** remove hardcoded env list from deploy workflow ([5c93e58](https://github.com/YoungSx/lb-worker-js/commit/5c93e58f78925fb69366a3bb6858b7d48c0e3638))

## [0.5.0](https://github.com/YoungSx/lb-worker-js/compare/v0.4.3...v0.5.0) (2026-01-01)


### 🔧 Maintenance

* replace REDIS_TLS_TOKEN to REDIS_TLS_PASSWORD ([0ea6bc2](https://github.com/YoungSx/lb-worker-js/commit/0ea6bc2865e046baf4c9ec94246564321bc2a55e))

### [0.4.3](https://github.com/YoungSx/lb-worker-js/compare/v0.4.2...v0.4.3) (2026-01-01)


### ✨ Features

* add Axiom logging integration and diagnostic capabilities ([2b86720](https://github.com/YoungSx/lb-worker-js/commit/2b86720007e346350daf8d4cf544acf9092a5f3b))

### [0.4.2](https://github.com/YoungSx/lb-worker-js/compare/v0.4.1...v0.4.2) (2026-01-01)


### 🐛 Bug Fixes

* improves logging consistency and error handling in Redis operations ([ceadfb9](https://github.com/YoungSx/lb-worker-js/commit/ceadfb9357999ce3acd25c9bf959446e559ddb49))

### [0.4.1](https://github.com/YoungSx/lb-worker-js/compare/v0.4.0...v0.4.1) (2026-01-01)

## [0.4.0](https://github.com/YoungSx/lb-worker-js/compare/v0.3.1...v0.4.0) (2026-01-01)


### 🐛 Bug Fixes

* adds missing wrangler.toml to .gitignore and improves build validation ([65fb1d2](https://github.com/YoungSx/lb-worker-js/commit/65fb1d2b64e9a37f4171eb778aad345c8fc1cb05))
* build ([fca3a61](https://github.com/YoungSx/lb-worker-js/commit/fca3a615aaa344a7173a4592fa9339cdd5d27321))
* build error ([b832cf7](https://github.com/YoungSx/lb-worker-js/commit/b832cf7d986ec7bf0b810f660083076aebefca04))
* correct syntax error in jest.config.js moduleNameMapper ([c5fcf8e](https://github.com/YoungSx/lb-worker-js/commit/c5fcf8e5079a9ce116ba6af2f391fd1c7dfe873e))
* standardize env vars, migrate from wrangler.toml to .env, fix REDIS_TLS config, update types ([d2ef91d](https://github.com/YoungSx/lb-worker-js/commit/d2ef91dd53c1c74118c011b21402adc2d918cfbc))


### ✨ Features

* add test:optimized and test:full-optimized scripts to package.json ([3c358af](https://github.com/YoungSx/lb-worker-js/commit/3c358af50ce3f9d8612ecf29f635c2af285e7de2))
* adds provider priority system with REDIS TLS > CF KV > Upstash fallback ([aff7d63](https://github.com/YoungSx/lb-worker-js/commit/aff7d631123a9f43b5afeee6e239186415860f2f))
* supplement missing REDIS TLS, legacy Redis, and R2 environment variables in manifest, env.example, and wrangler files ([3b0447b](https://github.com/YoungSx/lb-worker-js/commit/3b0447bebf40a80a2172601a3b6cdc9a6dab36ee))
* sync .clinerules with drive-collector-js standards ([9026dff](https://github.com/YoungSx/lb-worker-js/commit/9026dffbe92e4e81463710c6f76011d0909a222f))
* upgrade jest.config.js with performance optimizations from drive-collector-js ([0c67bc2](https://github.com/YoungSx/lb-worker-js/commit/0c67bc28a80e9f6f550c1cace3c5e66809da8567))

### [0.3.1](https://github.com/YoungSx/lb-worker-js/compare/v0.3.0...v0.3.1) (2025-12-31)


### 🐛 Bug Fixes

* wrangler ([9548252](https://github.com/YoungSx/lb-worker-js/commit/9548252036342e9fceb57a79c2f5d9ae6b5802f1))

## [0.3.0](https://github.com/YoungSx/lb-worker-js/compare/v0.2.1...v0.3.0) (2025-12-31)


### 🔧 Maintenance

* adds path normalization and Northflank/Cloudflare cache configurations ([591fc2a](https://github.com/YoungSx/lb-worker-js/commit/591fc2a41dfca92c46cb3cf04480b6b41ed4168d))

### [0.2.1](https://github.com/YoungSx/lb-worker-js/compare/v0.2.0...v0.2.1) (2025-12-31)


### ✨ Features

* add version tracking to build and logging system ([ce04abf](https://github.com/YoungSx/lb-worker-js/commit/ce04abf6fb20b270ea339d281a7ed514e807dfd4))


### 🐛 Bug Fixes

* enhances logging and health check with structured output ([308f846](https://github.com/YoungSx/lb-worker-js/commit/308f846348c4459a9cad9b1ad1e213a3805d6621))
* health ([7b06466](https://github.com/YoungSx/lb-worker-js/commit/7b0646654c91ec41705cbd304d5f23155bfa2692))

## [0.2.0](https://github.com/YoungSx/lb-worker-js/compare/v0.1.6...v0.2.0) (2025-12-31)


### ✨ Features

* add native Axiom logs batching, retain OTel traces, fix semantic fields ([4baddfd](https://github.com/YoungSx/lb-worker-js/commit/4baddfd6355b1037fa9bd5694d29db4bb7167087))
* adds consistent instanceId to tracing events ([e2ecc70](https://github.com/YoungSx/lb-worker-js/commit/e2ecc7070e0521fa40818e4f62f8ca7e1cf15cca))

### [0.1.6](https://github.com/YoungSx/lb-worker-js/compare/v0.1.5...v0.1.6) (2025-12-31)


### ✅ Testing

* add body log ([de736b3](https://github.com/YoungSx/lb-worker-js/commit/de736b34fa810185c582a279d8e5ff88f1c8a8ba))


### 🔧 Maintenance

* refactors OpenTelemetry initialization to use static imports and instrumentation wrapper ([56e9b16](https://github.com/YoungSx/lb-worker-js/commit/56e9b1655f3c129e5afba50f2c5b5860e523d611))
* updates QStash import path to use Cloudflare-specific module ([2064e20](https://github.com/YoungSx/lb-worker-js/commit/2064e208c6f1d65c95082e24329e51a91173e5b))


### 🐛 Bug Fixes

* axiom ([73f1126](https://github.com/YoungSx/lb-worker-js/commit/73f1126befa8ef14aff4e59c9f5fbc5128c862e4))
* enables replay protection bypass for QStash signature verification ([4a13f38](https://github.com/YoungSx/lb-worker-js/commit/4a13f38148192cb8e3d0bd5c2de811bca776bafe))
* logger ([5a95b79](https://github.com/YoungSx/lb-worker-js/commit/5a95b79c106ebcf118d03e270c375f59d6da8b3c))
* manual timestamp expiration check in verifyQStashSignature ([0ef9890](https://github.com/YoungSx/lb-worker-js/commit/0ef9890fcba9195ec61df43ddd46fc5e8fbf8fb0))
* OTel library crash when accessing undefined env variables ([721772c](https://github.com/YoungSx/lb-worker-js/commit/721772cf9ab2caf874dc60db3f2358ca2f736ef6))
* resolve global reference and qstash signature verification in CF Worker ([265d75f](https://github.com/YoungSx/lb-worker-js/commit/265d75f7069ac08b1974b446472b330534c97bec))
* sign ([9268118](https://github.com/YoungSx/lb-worker-js/commit/92681181122866e73016ae05a1fdf68ada9829fa))
* update QStash dependency and improve signature verification ([26ab01f](https://github.com/YoungSx/lb-worker-js/commit/26ab01f58049d964d22e45d362905d24c996da6c))

### [0.1.5](https://github.com/YoungSx/lb-worker-js/compare/v0.1.4...v0.1.5) (2025-12-30)

### [0.1.4](https://github.com/YoungSx/lb-worker-js/compare/v0.1.3...v0.1.4) (2025-12-30)

### [0.1.2](https://github.com/YoungSx/lb-worker-js/compare/v0.1.1...v0.1.2) (2025-12-29)


### 📝 Documentation

* update CHANGELOG.md for v0.1.1 release ([b8f63af](https://github.com/YoungSx/lb-worker-js/commit/b8f63aff8721b3abe17227a5326dcd5423b2a68a))


### 🐛 Bug Fixes

* improve sync-manifest workflow with better error handling and variable usage ([fd3cc8a](https://github.com/YoungSx/lb-worker-js/commit/fd3cc8abbdf9ded52205cf14c9cc342674f340c2))

## [0.1.1] - 2025-12-29

### Added
- **自动同步工作流**：新增 GitHub Actions 工作流，自动同步版本更新到 manifest.json。
- **manifest 验证增强**：完善 manifest.json 的 schema 验证和自动化测试。

### Changed
- **发布流程优化**：集成 AI 增强的发布脚本，自动处理版本同步和文件更新。
- **CI/CD 配置**：优化 GitHub Actions 工作流配置，提升部署可靠性。

## [1.1.0] - 2025-12-29

### Added
- **精细化任务调度失败处理策略**：
  - 无活跃实例时返回 **503 Service Unavailable** + `Retry-After: 60` 头部，指导 QStash 退避重试。
  - 实例返回 **4xx** 错误时直接透传并停止重试其他实例，避免无效重试循环。
  - 所有实例返回 **5xx** 时透传最后一个 5xx 响应，允许 QStash 继续重试。
- **增强日志记录**：所有错误场景中记录 `Upstash-Message-Id` 和 `Upstash-Retries` 元数据，提升可观测性和调试能力。
- **新增 LBError 类**：用于精细化错误处理，区分业务错误和内部错误。
- **完整测试覆盖**：新增 `__tests__/new-features.test.js`，覆盖 4xx 停止重试、5xx 透传、QStash 元数据记录和 Retry-After 头部等场景，确保 100% 测试通过。

### Changed
- **src/index.js**：优化转发逻辑，集成 LBError 类，更新状态码和头部处理，增强日志输出。
- **__tests__/index.test.js**：更新现有测试以兼容新逻辑，确保所有测试通过。

### Fixed
- 修复了之前所有错误统一返回 500 的问题，避免误导 QStash 重试策略。
- 修复了缺乏 QStash 元数据记录的问题，提升生产环境调试效率。

### Migration Notes
- **无需手动重新塞回 QStash**：LB 现在通过 HTTP 状态码和头部指导 QStash 自动重试，无需额外干预。
- **日志监控**：建议在生产环境中监控 `Upstash-Message-Id` 和 `Upstash-Retries` 日志，以跟踪重试行为。
- **死信队列 (DLQ)**：QStash 会自动处理 4xx 错误进入 DLQ，无需 LB 额外配置。

## [1.0.0] - Initial Release
- 基础负载均衡器功能：从 KV 存储获取实例列表，转发请求到活跃实例。
- 支持健康检查和基本错误处理。