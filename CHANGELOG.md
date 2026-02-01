# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [4.30.0](https://github.com/YoungSx/drive-collector-js/compare/v4.29.0...v4.30.0) (2026-02-01)


### 📝 文档更新

* **cloudflared:** add configuration guide for tunnel setup and troubleshooting ([3148200](https://github.com/YoungSx/drive-collector-js/commit/314820034b45a9f0e60cb7d54b813c2b38329230))


### 🐛 问题修复

* adds s6-overlay finish script for controlled service restart logic ([a72cc8f](https://github.com/YoungSx/drive-collector-js/commit/a72cc8fd0e08c62e3db568db60b1fde1a2715567))
* **telegram:** handle AUTH_KEY_DUPLICATED error with session cleanup ([8e8f82b](https://github.com/YoungSx/drive-collector-js/commit/8e8f82b4a8b27c0b383476626c8b4651cd009dce))


### ✨ 新特性

* **config:** relocate config import to top of file for better readability ([1a317d0](https://github.com/YoungSx/drive-collector-js/commit/1a317d07139dad08e03aed587fff448676902d70))
* **config:** remove legacy Redis and Valkey environment variables ([cfd9c72](https://github.com/YoungSx/drive-collector-js/commit/cfd9c7229493c6a44e828864a54c5cb933c66dac))
* **docs:** add logging guidelines document ([00f35fb](https://github.com/YoungSx/drive-collector-js/commit/00f35fbbb5a5888073db41915180a9933b9b8379))
* **InstanceCoordinator:** relocate instance ID log message to start method ([b0b6744](https://github.com/YoungSx/drive-collector-js/commit/b0b6744a199a9c35a62305662789fa8c1171ae35))
* **logger:** add debug log for successful log batch submission ([21bfc53](https://github.com/YoungSx/drive-collector-js/commit/21bfc53dad671baa54fe95d1befa514eef9de2e5))
* **logger:** add emoji prefixes to log levels and refine NewrelicLogger diagnostics ([eac3eb0](https://github.com/YoungSx/drive-collector-js/commit/eac3eb031bb43077cf19c079c3fe9693740f1ffb))
* **logger:** enhance ConsoleLogger with version tracking and improved formatting ([064573b](https://github.com/YoungSx/drive-collector-js/commit/064573b550f1ea75347ff1fe414ef7c58f9cb2fd))
* **logger:** enhance NewrelicLogger error handling and debugging ([bf31c01](https://github.com/YoungSx/drive-collector-js/commit/bf31c01117027d9eb95fc160013925eec224a93d))
* **logger:** enhance NewrelicLogger license key handling and debugging ([ad9b60b](https://github.com/YoungSx/drive-collector-js/commit/ad9b60b589e3b8bf971a6bda884d9b9fa4e4c59a))
* **logger:** implement smart filtering and output optimization ([62c6c1d](https://github.com/YoungSx/drive-collector-js/commit/62c6c1d4e23a3d789497726de85a31203512de0f))
* **logger:** refactor log formatting and enhance emoji semantics ([16c9180](https://github.com/YoungSx/drive-collector-js/commit/16c9180aa90db01dfa24dc378cd725f5f8c0a45f))
* **logger:** support dynamic reloading of logger configuration ([57743f4](https://github.com/YoungSx/drive-collector-js/commit/57743f4922f6cc4f26469896d23d6af9fcb1030a))
* **logger:** update New Relic API key header from Api-Key to X-License-Key ([d8f151a](https://github.com/YoungSx/drive-collector-js/commit/d8f151a2d24d13f94720175307436959a7fb8aa8))
* **s6-overlay:** refactor app finish logic and add shutdown diagnostics ([b7d53f4](https://github.com/YoungSx/drive-collector-js/commit/b7d53f424291821882c6240b52c0339826228f9c))
* **utils:** add sanitizeHeaders to clean HTTP response headers ([c646b71](https://github.com/YoungSx/drive-collector-js/commit/c646b71267e27f98bc84e34d3417f6fe2b75aa05))

## [4.29.0](https://github.com/YoungSx/drive-collector-js/compare/v4.28.1...v4.29.0) (2026-01-23)


### 🔧 其他任务

* adds distributed instance configuration ([a0e9696](https://github.com/YoungSx/drive-collector-js/commit/a0e9696a06d185427fdef4dcfaa24630afda6fba))
* adds Docker Compose configuration for drive collector services ([2ab881a](https://github.com/YoungSx/drive-collector-js/commit/2ab881aefc93fee8ce167c5ffc7a8dde0c7abc3e))
* removes cloud storage diagnostic functionality ([c47ef91](https://github.com/YoungSx/drive-collector-js/commit/c47ef916304ab2be51ba37939f9f112b09663cdb))


### ♻️ 代码重构

* BatchProcessor test mocks and improve test organization ([a193367](https://github.com/YoungSx/drive-collector-js/commit/a193367365a32dc854feeb65ef8341d6b2def990))
* unify CI/CD pipeline with enhanced Docker and notification support ([4e24633](https://github.com/YoungSx/drive-collector-js/commit/4e246332406fa43dd8b8ad10d7070fa44d3fcf09))
* webhook handling and improves startup resilience ([57defc6](https://github.com/YoungSx/drive-collector-js/commit/57defc6ef1a1f72d4a2b97b12fb3b2307ade6a69))


### 🐛 问题修复

* adds GitHub App authentication for Docker operations ([ac39b76](https://github.com/YoungSx/drive-collector-js/commit/ac39b760fdbbdf9be6d733faeba2f5e0cb6e448c))
* adds webhook forwarding for non-leader instances ([b90682a](https://github.com/YoungSx/drive-collector-js/commit/b90682a994e47d9ed931591cac0ab9e1cf568959))
* improves dispatcher robustness with error handling ([8a4080b](https://github.com/YoungSx/drive-collector-js/commit/8a4080b29be94726e2df9a53190a07af21f889d3))
* improves TunnelService error handling and initialization robustness ([5234193](https://github.com/YoungSx/drive-collector-js/commit/52341935f3548410cfaf045425907668999a52b9))

### [4.28.1](https://github.com/YoungSx/drive-collector-js/compare/v4.28.0...v4.28.1) (2026-01-17)


### 🐛 问题修复

* adds bound list title and not found message for drive management ([cf0b2d7](https://github.com/YoungSx/drive-collector-js/commit/cf0b2d71d5126739bb6fa3706369fc7a79c12923))
* adds drive locale strings import ([c3f0d91](https://github.com/YoungSx/drive-collector-js/commit/c3f0d9112756e82463505a48d3e361fae190e743))
* adds drive type selection UI for better drive binding ([a90d0ef](https://github.com/YoungSx/drive-collector-js/commit/a90d0ef9802d039b4c9cf6c56cd7ea58429515ad))
* enhance multi-drive support in DriveConfigFlow and related modules ([7c9be3d](https://github.com/YoungSx/drive-collector-js/commit/7c9be3d570e497573f2df8ac05cce36f0d985f50))
* enhances file linking in transfer status messages ([3f5111c](https://github.com/YoungSx/drive-collector-js/commit/3f5111ced3ed476fdb0f98353ed9fa5904b3a76e))
* ensures totalSize is always a valid number ([1ff8f85](https://github.com/YoungSx/drive-collector-js/commit/1ff8f854de7ba71643dfc51cad4177f81fdd6382))


### ✨ 新特性

* adds version display across the application ([c1039e4](https://github.com/YoungSx/drive-collector-js/commit/c1039e4a6405a9e6ecd6a21508badf3db47f15fa))

## [4.28.0](https://github.com/YoungSx/drive-collector-js/compare/v4.27.0...v4.28.0) (2026-01-16)


### 🔧 其他任务

* add New Relic logging integration ([1fcefd4](https://github.com/YoungSx/drive-collector-js/commit/1fcefd461278c1a53baa9b43ff68411f6a7c8ed6))


### ♻️ 代码重构

* add drive provider architecture and Mega implementation ([ba1a750](https://github.com/YoungSx/drive-collector-js/commit/ba1a7503fb1e287056487d9d931da6095cca9b1d))


### ✨ 新特性

* add test cases and implementations for multiple cloud storage providers ([33162ea](https://github.com/YoungSx/drive-collector-js/commit/33162ea58169c5ce26e47b486d41e80b1b7afbc3))

## [4.27.0](https://github.com/YoungSx/drive-collector-js/compare/v4.26.0...v4.27.0) (2026-01-16)


### ♻️ 代码重构

* media group buffer storage to use atomic operations ([5850b0d](https://github.com/YoungSx/drive-collector-js/commit/5850b0d88e6e20a327f427594df64671d89f4468))
* MediaGroupBuffer for better testability and reliability ([2307ee2](https://github.com/YoungSx/drive-collector-js/commit/2307ee26639b45ec77839408251f6cddf1eaba6f))


### 🔧 其他任务

* adds stream forwarding status logging ([34ac3bb](https://github.com/YoungSx/drive-collector-js/commit/34ac3bb556ece5d1207115c9338380a10248061f))


### 🐛 问题修复

* adds batch task processing with status message updates ([d100237](https://github.com/YoungSx/drive-collector-js/commit/d1002371f9c7146b22af5295f730a6346663d815))
* adds group task detection for QStash webhooks ([5631a1b](https://github.com/YoungSx/drive-collector-js/commit/5631a1bc4ed48acfcec49d3676e5e1a0ef74acc5))
* adds remote flush support for media group buffer ([f774a36](https://github.com/YoungSx/drive-collector-js/commit/f774a367ced71d827e9f136fb4a09fce5392d82c))
* adds role management methods to AuthGuard ([06a56b9](https://github.com/YoungSx/drive-collector-js/commit/06a56b958a2c147eecb0be3605aa52a1aa68ce68))
* improves admin command setup with proper peer validation ([c8dc915](https://github.com/YoungSx/drive-collector-js/commit/c8dc915921f173ef5f5fca9f11ea77fc4df1e09b))
* improves lock acquisition robustness with non-numeric TTL handling ([e167bef](https://github.com/YoungSx/drive-collector-js/commit/e167bef0e0b58c69277578258603c7e2725cddde))
* simplifies local timer configuration logic ([6e494c0](https://github.com/YoungSx/drive-collector-js/commit/6e494c0023d3557402ffd70da8bee5fe274fa417))


### ✨ 新特性

* adds admin promotion/demotion commands ([ea13938](https://github.com/YoungSx/drive-collector-js/commit/ea13938bc9d4982646fd5bf1885d82e3e85f5de1))
* adds error handling for admin command setup ([cab07bc](https://github.com/YoungSx/drive-collector-js/commit/cab07bc44039c7ab4d8cd9974ddf9ea193e37f70))
* adds manual configuration refresh via webhook ([050a5c5](https://github.com/YoungSx/drive-collector-js/commit/050a5c5d7d7ad96bb732c23ec9e209f22411d0d7))
* adds New Relic logger support and improves logger architecture ([ed2847d](https://github.com/YoungSx/drive-collector-js/commit/ed2847da2baefa8c1ceffdf41b8889ad10d356e9))
* enhances AuthGuard with RBAC and maintenance mode support ([0eec0a2](https://github.com/YoungSx/drive-collector-js/commit/0eec0a2782ba668d8aa4de964a13b5d0819b19f4))

## [4.26.0](https://github.com/YoungSx/drive-collector-js/compare/v4.25.0...v4.26.0) (2026-01-15)


### ✨ 新特性

* add stream forwarding support for distributed uploads ([01c39e2](https://github.com/YoungSx/drive-collector-js/commit/01c39e2b3f509b0336da89952231761ffba01553))
* adds Cloudflare tunnel and s6-overlay for process management ([1a6b179](https://github.com/YoungSx/drive-collector-js/commit/1a6b1796068f59518520ecca558eeedf18c8947d))
* adds idempotency check for chunk processing ([866daee](https://github.com/YoungSx/drive-collector-js/commit/866daee69c2b30855a3276ca88ece48be99dbb90))
* implements breakpoint resume functionality for stream transfers ([0766c91](https://github.com/YoungSx/drive-collector-js/commit/0766c91dbdd432ca0e67574a2512ee0eb8915d24))
* replaces console logging with structured logging ([f343d7c](https://github.com/YoungSx/drive-collector-js/commit/f343d7c8a8ea4f4926166b6bf85171d79a03b97a))


### 🐛 问题修复

* adds custom entrypoint script with process management ([803e889](https://github.com/YoungSx/drive-collector-js/commit/803e88997acf529b6b13f77485d7a262f3aee0ae))
* adds working directory change to Node.js application startup ([23652f1](https://github.com/YoungSx/drive-collector-js/commit/23652f12cd70396d8ad45e951b2bde77bcc92325))
* ensures Telegram connection before task execution ([63050f9](https://github.com/YoungSx/drive-collector-js/commit/63050f9bcbbc7fc31b136f242e59e83839c1e8fb))
* improve error handling and logging across multiple components ([85ac44e](https://github.com/YoungSx/drive-collector-js/commit/85ac44e21074083321027844ce71323f0b5a400f))

## [4.25.0](https://github.com/YoungSx/drive-collector-js/compare/v4.24.1...v4.25.0) (2026-01-14)


### 📝 文档更新

* adds INSTANCE_COUNT environment variable configuration ([2621284](https://github.com/YoungSx/drive-collector-js/commit/2621284846256bdbb3404c4833b590ab8ba5296d))
* STANDARDIZATION_SOP.md ([26b4a79](https://github.com/YoungSx/drive-collector-js/commit/26b4a795b572185c91b7fd65aaf49fc367f434e3))


### 🐛 问题修复

* adds limit configuration for stalled task queries ([cbcfe5e](https://github.com/YoungSx/drive-collector-js/commit/cbcfe5edc8c811eb2356b3d74a0b6303de2d57a4))
* adds production environment dotenv override control ([c207470](https://github.com/YoungSx/drive-collector-js/commit/c2074708c7c68a81f4e614d7f624b52a2b91674f))
* adds QStash debug logging and improves error handling ([ced0582](https://github.com/YoungSx/drive-collector-js/commit/ced0582a0a54004e616fb6b74dece5790b611a82))
* enhances queue service metadata handling and QStash token fallback ([304855f](https://github.com/YoungSx/drive-collector-js/commit/304855fd4109dd8ae93ec7c1756d613e612eaf71))
* improves cache provider logging and performance thresholds ([f6ed931](https://github.com/YoungSx/drive-collector-js/commit/f6ed931f11fca4b0c7dc8421886725edb775f4c1))
* improves cancellation handling for rclone batch uploads ([3454431](https://github.com/YoungSx/drive-collector-js/commit/345443147d4de2d91c4855560a22d087920ced1c))
* improves distributed lock robustness with timestamp validation ([e92081b](https://github.com/YoungSx/drive-collector-js/commit/e92081b4655c6eb9d9a417f4d7b603b163f916d1))
* improves task cancellation handling and adds batch cancellation support ([20cf2a1](https://github.com/YoungSx/drive-collector-js/commit/20cf2a1aa17133aa193b819118caf6a4b5d4b94d))

### [4.24.1](https://github.com/YoungSx/drive-collector-js/compare/v4.24.0...v4.24.1) (2026-01-14)


### ✨ 新特性

* implement manifest-based configuration management for dynamic service reinitialization ([dd015bd](https://github.com/YoungSx/drive-collector-js/commit/dd015bd198cb0a51bf557e1ddcd7167a473f2990))


### 🐛 问题修复

* improves D1 configuration validation and error handling ([44844eb](https://github.com/YoungSx/drive-collector-js/commit/44844eb49f542c8e530baf843b6d2d45ce0ee3d9))
* improves user-specific upload path handling in file operations ([a47cc56](https://github.com/YoungSx/drive-collector-js/commit/a47cc56d4373134999a418d71da086c2a6e82b15))

## [4.24.0](https://github.com/YoungSx/drive-collector-js/compare/v4.22.0...v4.24.0) (2026-01-13)


### 📝 文档更新

* add AGENTS.md with development guidelines ([44d4e57](https://github.com/YoungSx/drive-collector-js/commit/44d4e576879c17bbeab0366563044463ad09622c))


### 🐛 问题修复

* adds active task count tracking functionality ([64d3269](https://github.com/YoungSx/drive-collector-js/commit/64d32697712fddd5fd9417f78a394c7ac1fb6a81))
* enhances logger mocking to support full LoggerService interface ([4882170](https://github.com/YoungSx/drive-collector-js/commit/48821706e67981df11629d506d4aab2a3f14ebbb))
* ensures Telegram connection before running bot tasks ([e127d91](https://github.com/YoungSx/drive-collector-js/commit/e127d9198c8be19e049fd913a46e865fdb7d3c37))
* updates mediaGroupBuffer import to use default export ([8edc8b9](https://github.com/YoungSx/drive-collector-js/commit/8edc8b9248f0b2ec50bf140ace1c051f69599d77))


### ✨ 新特性

* adds instance-level active task count aggregation ([f553540](https://github.com/YoungSx/drive-collector-js/commit/f55354071567e00592948ec4284f67695a51812d))


### 🔧 其他任务

* adds dynamic heartbeat adjustment for reliability ([e1c06e1](https://github.com/YoungSx/drive-collector-js/commit/e1c06e120557d2af5c39f936e403adc47dfc5de8))
* adds MCP support and updates .gitignore ([8a524a3](https://github.com/YoungSx/drive-collector-js/commit/8a524a33f56f374e4e1a3a81bab1777804c2cfa6))
* **release:** 4.23.0 ([991fe3f](https://github.com/YoungSx/drive-collector-js/commit/991fe3f4847711f07a1c1f51e6c64ce269888e31))


### ♻️ 代码重构

* consistent variable naming for Cloudflare KV configuration ([e97d2ae](https://github.com/YoungSx/drive-collector-js/commit/e97d2aec97cc9aba11793d5fe291296e73fe860c))
* enhance distributed system reliability with new services and fixes ([d079c3d](https://github.com/YoungSx/drive-collector-js/commit/d079c3df92b191a2b89766d5ddab8dcf5f2ca39e))
* instance tracking to use cache-only storage ([8d0ffb8](https://github.com/YoungSx/drive-collector-js/commit/8d0ffb88ca44c4930556c4685062deb6d249a38a))


### ✅ 测试相关

* add Cloudflare KV and D1 configuration tests ([91d2851](https://github.com/YoungSx/drive-collector-js/commit/91d2851d5e2de879204c11846abe1ef516ccdb75))
* adds test for verifying DC setting enforcement ([9467567](https://github.com/YoungSx/drive-collector-js/commit/94675674bedfd2ca04c6951c06e533c69edf4a36))
* improve test environment setup and mocking ([5d1fef3](https://github.com/YoungSx/drive-collector-js/commit/5d1fef387600c4993dd54586682ce7f740dae870))

## [4.23.0](https://github.com/YoungSx/drive-collector-js/compare/v4.22.0...v4.23.0) (2026-01-13)


### ✅ 测试相关

* adds test for verifying DC setting enforcement ([9467567](https://github.com/YoungSx/drive-collector-js/commit/94675674bedfd2ca04c6951c06e533c69edf4a36))
* improve test environment setup and mocking ([5d1fef3](https://github.com/YoungSx/drive-collector-js/commit/5d1fef387600c4993dd54586682ce7f740dae870))


### 📝 文档更新

* add AGENTS.md with development guidelines ([44d4e57](https://github.com/YoungSx/drive-collector-js/commit/44d4e576879c17bbeab0366563044463ad09622c))


### 🔧 其他任务

* adds MCP support and updates .gitignore ([8a524a3](https://github.com/YoungSx/drive-collector-js/commit/8a524a33f56f374e4e1a3a81bab1777804c2cfa6))


### ♻️ 代码重构

* enhance distributed system reliability with new services and fixes ([d079c3d](https://github.com/YoungSx/drive-collector-js/commit/d079c3df92b191a2b89766d5ddab8dcf5f2ca39e))


### 🐛 问题修复

* adds active task count tracking functionality ([64d3269](https://github.com/YoungSx/drive-collector-js/commit/64d32697712fddd5fd9417f78a394c7ac1fb6a81))
* enhances logger mocking to support full LoggerService interface ([4882170](https://github.com/YoungSx/drive-collector-js/commit/48821706e67981df11629d506d4aab2a3f14ebbb))
* ensures Telegram connection before running bot tasks ([e127d91](https://github.com/YoungSx/drive-collector-js/commit/e127d9198c8be19e049fd913a46e865fdb7d3c37))
* updates mediaGroupBuffer import to use default export ([8edc8b9](https://github.com/YoungSx/drive-collector-js/commit/8edc8b9248f0b2ec50bf140ace1c051f69599d77))


### ✨ 新特性

* adds instance-level active task count aggregation ([f553540](https://github.com/YoungSx/drive-collector-js/commit/f55354071567e00592948ec4284f67695a51812d))

## [4.22.0](https://github.com/YoungSx/drive-collector-js/compare/v4.20.1...v4.22.0) (2026-01-13)


### ♻️ 代码重构

* enhance QueueService with metadata improvements and validation ([b9f0b26](https://github.com/YoungSx/drive-collector-js/commit/b9f0b26986098781e3c3ed97a709ed3e77b62c8b))
* enhances QstashQueue with robust messaging features ([cd8a164](https://github.com/YoungSx/drive-collector-js/commit/cd8a1648e499d3e6145e8176afbc057f7b6efbd0))

## [4.21.0](https://github.com/YoungSx/drive-collector-js/compare/v4.20.0...v4.21.0) (2026-01-12)


### 🔧 其他任务

* **release:** 4.21.0 ([35bc9ff](https://github.com/YoungSx/drive-collector-js/commit/35bc9ffe69772bcefcb26a381140b0947214e9cc))

## [4.21.0](https://github.com/YoungSx/drive-collector-js/compare/v4.20.0...v4.21.0) (2026-01-12)


### ♻️ 代码重构

* Infisical secrets provider with base provider architecture ([87a9476](https://github.com/YoungSx/drive-collector-js/commit/87a94766fb733084f2a8b1e58f15a4db563521f0))
* secrets provider tests into comprehensive suite ([116736e](https://github.com/YoungSx/drive-collector-js/commit/116736ee79313dda085bf16ad38799a3159f7bd2))

## [4.21.0](https://github.com/YoungSx/drive-collector-js/compare/v4.20.0...v4.21.0) (2026-01-12)


### ♻️ 代码重构

* Infisical secrets provider with base provider architecture ([87a9476](https://github.com/YoungSx/drive-collector-js/commit/87a94766fb733084f2a8b1e58f15a4db563521f0))
* secrets provider tests into comprehensive suite ([116736e](https://github.com/YoungSx/drive-collector-js/commit/116736ee79313dda085bf16ad38799a3159f7bd2))

## [4.20.0](https://github.com/YoungSx/drive-collector-js/compare/v4.19.2...v4.20.0) (2026-01-12)


### 🐛 问题修复

* ensure cache is properly cleared when updating remote folder ([738e4b0](https://github.com/YoungSx/drive-collector-js/commit/738e4b088db4445147299a8f2c93dd3ff5e70379))
* improve test resilience and add detailed logging for D1 service ([c67035f](https://github.com/YoungSx/drive-collector-js/commit/c67035f820d01d3197ba98724c75a4acaa29493a))
* improves error handling for D1 authentication failures ([5982f83](https://github.com/YoungSx/drive-collector-js/commit/5982f83eea1f7bc580011be34fe3116884b8236a))


### ♻️ 代码重构

* add CloudQueueBase abstract class and improve QstashQueue implementation ([9137823](https://github.com/YoungSx/drive-collector-js/commit/91378231e031a4fdc3c38851ea2d6e255618d01b))

### [4.19.2](https://github.com/YoungSx/drive-collector-js/compare/v4.19.1...v4.19.2) (2026-01-12)


### 🔧 其他任务

* adds diagnostic logging for message processing ([13916f3](https://github.com/YoungSx/drive-collector-js/commit/13916f325fa5ec7bfffabb580828b3780a1be246))

### [4.19.1](https://github.com/YoungSx/drive-collector-js/compare/v4.19.0...v4.19.1) (2026-01-12)


### 🐛 问题修复

* ensures logger instance ID is set for all logging services ([c3aaec8](https://github.com/YoungSx/drive-collector-js/commit/c3aaec8ecd7e12b77247c2f1f8d2fb9b6f50885e))

## [4.19.0](https://github.com/YoungSx/drive-collector-js/compare/v4.18.2...v4.19.0) (2026-01-12)


### ✅ 测试相关

* automated testing migrated from jest to vitest ([ff0e84f](https://github.com/YoungSx/drive-collector-js/commit/ff0e84f013d0e4794c1bc7e33a70947c78c323b1))
* improve test mocking and environment handling in configuration tests ([6e55cac](https://github.com/YoungSx/drive-collector-js/commit/6e55cace1ebbed0b84e8dde458ba28f5ef3ee50f))


### ✨ 新特性

* add custom upload path configuration for drives ([b63d643](https://github.com/YoungSx/drive-collector-js/commit/b63d643dcca0363a33252ad4c83087ccd9602356))
* adds healthz and ready endpoints for service monitoring ([9db2870](https://github.com/YoungSx/drive-collector-js/commit/9db2870f44a6e3c45bbb99d201a4c7bdb73fbd9a))
* enhance log flushing with timeout and graceful shutdown integration ([483dcd3](https://github.com/YoungSx/drive-collector-js/commit/483dcd3745091de1f7e60b5777c0a4c0f1ebfc0a))


### 🔧 其他任务

* adds ~/ to .gitignore ([fd01347](https://github.com/YoungSx/drive-collector-js/commit/fd01347922a9662b98fe3d44dba67b5ba18cce45))
* adds comprehensive env field testing to logger service ([e957430](https://github.com/YoungSx/drive-collector-js/commit/e957430ad1478c923e84e043acfed611aa51441c))
* adds remote_folder column to drives table ([050bd5c](https://github.com/YoungSx/drive-collector-js/commit/050bd5c0db2a4999206f8395f34ced88ffcc23fc))
* min_machines_running on fly.io ([402194e](https://github.com/YoungSx/drive-collector-js/commit/402194e54ce2bef665c1bbd4e28f991434b3b844))


### ♻️ 代码重构

* enhance health endpoint resilience and startup error handling ([9a842fc](https://github.com/YoungSx/drive-collector-js/commit/9a842fce281c7cdc344a781af1104378b382e9fb))
* improve logger functionality and performance tracking ([454bc0d](https://github.com/YoungSx/drive-collector-js/commit/454bc0dc69623c6f5bad33a87e391be7a35ae409))
* LoggerService ([780139d](https://github.com/YoungSx/drive-collector-js/commit/780139d3515e800158a808db95f5b5ba34d3078b))


### 🐛 问题修复

* add Redis connection keepalive and fix startup resilience test ([052d89c](https://github.com/YoungSx/drive-collector-js/commit/052d89c36cc13fe70ba7623b9f40fc5daaad0bb1))
* improves logger initialization sequence and reliability ([94e3809](https://github.com/YoungSx/drive-collector-js/commit/94e380946aeeaf725b1a7f197fda62ff17a9291f))
* improves Telegram client connection reliability ([3aa8b29](https://github.com/YoungSx/drive-collector-js/commit/3aa8b29fcf317452d08b861d526782567f9fb51e))
* improves Telegram error handling and recovery logic ([7d23d0f](https://github.com/YoungSx/drive-collector-js/commit/7d23d0fd8f2d691515f5e3e58cbfae6a14bd3138))
* remove mistakenly tracked ~ directory file ([f2aa937](https://github.com/YoungSx/drive-collector-js/commit/f2aa9376b5bf618d114297a3a85f4ad32ad55cc0))

### [4.18.2](https://github.com/YoungSx/drive-collector-js/compare/v4.18.1...v4.18.2) (2026-01-10)


### 📝 文档更新

* adds SQL initialization scripts for project setup ([80703ba](https://github.com/YoungSx/drive-collector-js/commit/80703baf43b43bb3e93e4c06af31c2990a524ea4))


### 🐛 问题修复

* improves Telegram error handling for connection issues ([8379fbe](https://github.com/YoungSx/drive-collector-js/commit/8379fbecf7a2fec052c637346e057f3d90f845d6))


### 🔧 其他任务

* adds AUTH_KEY_DUPLICATED to graceful shutdown error list ([959ac8c](https://github.com/YoungSx/drive-collector-js/commit/959ac8ca69b1e55808b021efafc34c202cb9c5c3))
* fly.toml ([4848e75](https://github.com/YoungSx/drive-collector-js/commit/4848e751e4cac691129c3f1b3fc9924ac0ff1c85))
* improves RedisCache logging with emoji indicators ([5561330](https://github.com/YoungSx/drive-collector-js/commit/55613307d2de50d727eb5bcacf6eda6c0db1e00b))

### [4.18.1](https://github.com/YoungSx/drive-collector-js/compare/v4.18.0...v4.18.1) (2026-01-10)


### 🐛 问题修复

* **telegram:** correct Telegram test mode DC setting and fix unit test isolation ([ccaa65a](https://github.com/YoungSx/drive-collector-js/commit/ccaa65ac3f3cc5b23d7720f8838b2158efcd1523))

## [4.18.0](https://github.com/YoungSx/drive-collector-js/compare/v4.17.0...v4.18.0) (2026-01-10)


### ♻️ 代码重构

* lifecycle management and improves configuration handling ([f5b13eb](https://github.com/YoungSx/drive-collector-js/commit/f5b13eb97eecca5a2dcf37250ae1946f5e660f70))


### 🐛 问题修复

* iImproves Redis connection logging with sensitive data masking ([1a3effb](https://github.com/YoungSx/drive-collector-js/commit/1a3effbce1ad3eac3da4ade7635ad2f8b71009bd))


### ✨ 新特性

* adds Axiom service suspension on unavailability ([54b6bf6](https://github.com/YoungSx/drive-collector-js/commit/54b6bf6fff8264e71bdad225acb53e27762a9008))
* adds log batching and flushing functionality ([074c29e](https://github.com/YoungSx/drive-collector-js/commit/074c29e4a614c49ee33d7e38c1f92f65ce251344))
* adds Telegram DC configuration overrides ([59a20e5](https://github.com/YoungSx/drive-collector-js/commit/59a20e5cf8abc03ce9db6cb870b9e58877ac6597))

## [4.17.0](https://github.com/YoungSx/drive-collector-js/compare/v4.16.0...v4.17.0) (2026-01-09)


### 🔧 其他任务

* remove accidentally committed test part files ([d0cb4de](https://github.com/YoungSx/drive-collector-js/commit/d0cb4def16b9e2f21028e9a545fab23dca654ceb))


### 📝 文档更新

* adds Telegram webhook setup documentation ([dddbf20](https://github.com/YoungSx/drive-collector-js/commit/dddbf20cd09ff4cb2ae48f3db6831542aa3f26fd))


### ✨ 新特性

* adds test mode support for Telegram bot API ([e0915d6](https://github.com/YoungSx/drive-collector-js/commit/e0915d60865b3f867d7cf538dde36a67c2b987df))


### ♻️ 代码重构

* improve test infrastructure with deterministic time and environment mocking ([d145680](https://github.com/YoungSx/drive-collector-js/commit/d145680baae4e6a3d8b2b2f1bac8dc785bba7b0e))
* QStashService to QueueService ([83318a0](https://github.com/YoungSx/drive-collector-js/commit/83318a00443e1915e36eea04dad9d79c2ff2e4ea))
* rename CF_REGION to INSTANCE_REGION ([759c86c](https://github.com/YoungSx/drive-collector-js/commit/759c86cbd06a7cb11d84fe0f5f4292e6a3a9d2b9))


### 🐛 问题修复

* add telegram.testMode to mockConfig in NetworkDiagnostic test ([97f28eb](https://github.com/YoungSx/drive-collector-js/commit/97f28eb86d0bae9d2eff071b0b70d00a6b758c9f))
* improves environment file loading based on NODE_ENV ([a3dcafd](https://github.com/YoungSx/drive-collector-js/commit/a3dcafde16d5f165021286c4bd68c8d098c807f8))
* INFISICAL_ENV in Dockerfile ([51f4dd3](https://github.com/YoungSx/drive-collector-js/commit/51f4dd3b67d9e0b848f15ff52b0ae2af63551156))
* updates dotenv configuration with explicit path specifications ([e7d5da1](https://github.com/YoungSx/drive-collector-js/commit/e7d5da1f8a1159a8efd531439b408cd78393f3fb))

## [4.16.0](https://github.com/YoungSx/drive-collector-js/compare/v4.15.4...v4.16.0) (2026-01-09)


### ✨ 新特性

* enhance task status handling with Redis fallback and circuit breaker ([f50cb73](https://github.com/YoungSx/drive-collector-js/commit/f50cb733148f04840ff692ed7faca87d17b6a693))

### [4.15.4](https://github.com/YoungSx/drive-collector-js/compare/v4.15.3...v4.15.4) (2026-01-09)


### ♻️ 代码重构

* standardizes NODE_ENV values and improves environment mapping ([23a72d1](https://github.com/YoungSx/drive-collector-js/commit/23a72d1f0079bee15f10991503f69f1c979e791f))


### ✨ 新特性

* enhances multi-environment support and configuration consistency ([cf8ae2a](https://github.com/YoungSx/drive-collector-js/commit/cf8ae2ab7ae99b810e4431f20624c96d83e93aaa))

### [4.15.3](https://github.com/YoungSx/drive-collector-js/compare/v4.15.2...v4.15.3) (2026-01-08)


### 🐛 问题修复

* **MessageHandler:** use debug level for UpdateConnectionState heartbeat events ([d5e8e1c](https://github.com/YoungSx/drive-collector-js/commit/d5e8e1c729fbb7ba50f7b70ecef7cd12ad98704f))

### [4.15.2](https://github.com/YoungSx/drive-collector-js/compare/v4.15.1...v4.15.2) (2026-01-08)


### 🐛 问题修复

* **MessageHandler:** add debug logs for unknown UpdateConnectionState events ([8a36568](https://github.com/YoungSx/drive-collector-js/commit/8a365683b2533f25ab7260de3827c182d28832ae))
* **MessageHandler:** correctly parse UpdateConnectionState events ([9e9fb52](https://github.com/YoungSx/drive-collector-js/commit/9e9fb52b015aae1cfdfc585c8c8b9d989dcfb510))

### [4.15.1](https://github.com/YoungSx/drive-collector-js/compare/v4.15.0...v4.15.1) (2026-01-08)


### ♻️ 代码重构

* improves cache provider detection and configuration ([c649135](https://github.com/YoungSx/drive-collector-js/commit/c649135af72af4cd3596f31eb49e0ddc212f36c7))


### 🐛 问题修复

* adds configurable download directory with fallback to system temp ([f553ea7](https://github.com/YoungSx/drive-collector-js/commit/f553ea730ffafe1a2782ffd9846b012d0118cfda))

## [4.15.0](https://github.com/YoungSx/drive-collector-js/compare/v4.14.0...v4.15.0) (2026-01-08)


### ♻️ 代码重构

* updates webhook endpoints to use shorter paths ([cfe5040](https://github.com/YoungSx/drive-collector-js/commit/cfe5040fa06387657d8cd72246b2157fc7a25d7d))

## [4.14.0](https://github.com/YoungSx/drive-collector-js/compare/v4.13.1...v4.14.0) (2026-01-07)


### ✅ 测试相关

* adds comprehensive upstream error diagnosis guides and monitoring scripts ([a9529fa](https://github.com/YoungSx/drive-collector-js/commit/a9529fa7587afa36b12f005982215292823e4803))


### ✨ 新特性

* add HTTP/2 support to webhook server ([3f3b326](https://github.com/YoungSx/drive-collector-js/commit/3f3b3266e5170fefa14aaac279f9a2f05007981d))

### [4.13.1](https://github.com/YoungSx/drive-collector-js/compare/v4.13.0...v4.13.1) (2026-01-07)


### ✅ 测试相关

* adds comprehensive 502 error diagnostic guide ([c68655d](https://github.com/YoungSx/drive-collector-js/commit/c68655d0278a35c3043e65df38fba156abf13ecf))


### 🐛 问题修复

* adds error handling for Axiom client initialization ([8554e73](https://github.com/YoungSx/drive-collector-js/commit/8554e7312fa42d4a21f1c58af664e7f9fdc1e831))

## [4.13.0](https://github.com/YoungSx/drive-collector-js/compare/v4.12.0...v4.13.0) (2026-01-07)


### ✨ 新特性

* add debug and monitoring tools for file processing issues ([b4ee4b2](https://github.com/YoungSx/drive-collector-js/commit/b4ee4b250561e9aa879c5df037f33058714f562d))
* implement graceful shutdown system with error recovery ([2257b03](https://github.com/YoungSx/drive-collector-js/commit/2257b034ca7d0a3cd0cc68507ca6a691139d6ee7))

## [4.12.0](https://github.com/YoungSx/drive-collector-js/compare/v4.11.0...v4.12.0) (2026-01-06)


### 🔧 其他任务

* expands system capabilities and configuration options ([06addaf](https://github.com/YoungSx/drive-collector-js/commit/06addaf4040edb42bdf4cd5026e0f587970b8cd4))
* reduces lock acquisition retry log noise ([f8e3d18](https://github.com/YoungSx/drive-collector-js/commit/f8e3d18e84398dc892c56a089dad7a3a36100784))


### ✨ 新特性

* add cache provider and failover status to instance diagnostics ([18fbeb4](https://github.com/YoungSx/drive-collector-js/commit/18fbeb4d0f881b1680349619fc0fc0f5d332f83e))

## [4.11.0](https://github.com/YoungSx/drive-collector-js/compare/v4.10.0...v4.11.0) (2026-01-06)


### ♻️ 代码重构

* improve logger module with context support and module-specific logging ([724f97d](https://github.com/YoungSx/drive-collector-js/commit/724f97d2af263fd5531a200ecf0d3e7d58ec9734))


### 🐛 问题修复

* resolve the error regarding Telegram lock during scrolling publishing ([2989c1d](https://github.com/YoungSx/drive-collector-js/commit/2989c1d05def2aa2f7219cf1ca7ec33e5736b91f))


### ✨ 新特性

* adds Redis/Valkey cache operations and key listing functionality ([f9d7997](https://github.com/YoungSx/drive-collector-js/commit/f9d799793802637466872275bbacce0a2f57693b))

## [4.10.0](https://github.com/YoungSx/drive-collector-js/compare/v4.9.1...v4.10.0) (2026-01-06)


### ♻️ 代码重构

*  CacheService test mocks and improve test coverage ([c71968a](https://github.com/YoungSx/drive-collector-js/commit/c71968ac05b8aec551a038e5fb3664930f2cbdf4))
* cache provider implementations to improve testability and reliability ([e009f2f](https://github.com/YoungSx/drive-collector-js/commit/e009f2fb136c727eb9b87b186c0131e17eb66980))
* refactor Cache and implement multi-provider cache system with L1/L2 architecture ([79566f2](https://github.com/YoungSx/drive-collector-js/commit/79566f2d2ab4490a275f40891c60be6fb223b132))


### ✅ 测试相关

* Iimproves test reliability and maintainability ([7050d74](https://github.com/YoungSx/drive-collector-js/commit/7050d741298b821fc8e15a6a3da354b5074edf1c))


### 🐛 问题修复

* enhances configuration logging with cache provider details ([f89b4e6](https://github.com/YoungSx/drive-collector-js/commit/f89b4e6a0d29599f125998f21f065c7d9a0ff574))
* improves error handling for Telegram startup failures ([ef775bc](https://github.com/YoungSx/drive-collector-js/commit/ef775bcc5b8148fd27a1b0ca509f82112ce1721a))
* improves Redis connection handling and status checks ([55fb6e2](https://github.com/YoungSx/drive-collector-js/commit/55fb6e236e51aba4775240ea4d41ca404492ea47))
* improves Redis URL construction with username/password support ([eb6b925](https://github.com/YoungSx/drive-collector-js/commit/eb6b9258d0e606d2d36bf23fde02578f0b61dca3))


### ✨ 新特性

* adds health check endpoint ([d9ad6e5](https://github.com/YoungSx/drive-collector-js/commit/d9ad6e5f8b24ac227a62b4d700dd97022cb81239))

### [4.9.1](https://github.com/YoungSx/drive-collector-js/compare/v4.9.0...v4.9.1) (2026-01-05)


### ♻️ 代码重构

* Enhances Infisical environment sync with validation and fallback logic ([2e0b57c](https://github.com/YoungSx/drive-collector-js/commit/2e0b57cb3c389a94f553f8589860c3f97b133c67))


### 🔧 其他任务

* add some log to sync-env ([4dc4f4a](https://github.com/YoungSx/drive-collector-js/commit/4dc4f4a2606b9126181d468980e63703ac1c0c81))
* improves QStash webhook verification debugging ([363cd96](https://github.com/YoungSx/drive-collector-js/commit/363cd9616ec69c8134a1d28d8270e0ef25d61a6e))


### 🐛 问题修复

* CacheService.test.js ([f713059](https://github.com/YoungSx/drive-collector-js/commit/f71305948ccf14750029d8172c61408452285683))
* improves error handling and script robustness ([f94d068](https://github.com/YoungSx/drive-collector-js/commit/f94d0685086b0028e6a1cb8edc8ba9fd61ce5cdd))
* update CF Cache required to false in manifest ([1deb891](https://github.com/YoungSx/drive-collector-js/commit/1deb8918f76d223b618a95803899f7998d2ccf8e))

## [4.9.0](https://github.com/YoungSx/drive-collector-js/compare/v4.8.1...v4.9.0) (2026-01-05)


### 🐛 问题修复

* adds environment mapping utility for Infisical integration ([8d519a7](https://github.com/YoungSx/drive-collector-js/commit/8d519a7066708f498aaf2cb3cbfb8d267cb0d188))
* adds fallback logging for payloads exceeding field limits ([2eb0cbb](https://github.com/YoungSx/drive-collector-js/commit/2eb0cbba78a5cd4967ac185f70f3888a4e7f36da))
* adjusts data pruning parameters for stricter logging ([71057e8](https://github.com/YoungSx/drive-collector-js/commit/71057e88c3aae501fe81b9adcaf73eda48ca069a))
* improves data handling for logging to prevent field explosion ([c4b2886](https://github.com/YoungSx/drive-collector-js/commit/c4b2886a0a805e0166aade2364fa1c0313090893))
* improves Infisical secrets logging for better debugging ([07f0e92](https://github.com/YoungSx/drive-collector-js/commit/07f0e92b42cccff14660b7e650eed71f0768ab84))
* refactors logger payload structure to simplify schema ([0f67717](https://github.com/YoungSx/drive-collector-js/commit/0f67717c9251e853e343a5081642e48f0daee0c0))
* removes redundant payload size validation ([3308038](https://github.com/YoungSx/drive-collector-js/commit/3308038ca3a16e8d4106da017f2fe4c7864fc486))


### ♻️ 代码重构

* infisical ([290dc90](https://github.com/YoungSx/drive-collector-js/commit/290dc9028b4bf8ef6ba4f64b34ae8ad1f77b51c7))
* refactors serialization logic into shared utilities ([4b0c7ee](https://github.com/YoungSx/drive-collector-js/commit/4b0c7eecc20e0fec3491ee607d7b1dd1174cd234))

### [4.8.1](https://github.com/YoungSx/drive-collector-js/compare/v4.8.0...v4.8.1) (2026-01-04)


### 🐛 问题修复

* adds debug logging for Axiom column limit errors ([2cf3884](https://github.com/YoungSx/drive-collector-js/commit/2cf38848cda28cb8763f6d56757e93f5420de4b0))
* improves data pruning for Axiom payloads ([679f0fd](https://github.com/YoungSx/drive-collector-js/commit/679f0fdda25194080d8186d561c67a7feaa25bfc))

## [4.8.0](https://github.com/YoungSx/drive-collector-js/compare/v4.7.1...v4.8.0) (2026-01-04)


### ♻️ 代码重构

* implement secure runtime configuration with Infisical integration ([b42a386](https://github.com/YoungSx/drive-collector-js/commit/b42a386503910e4f83a8f2abcd3e6ecf11c28334))
* upgrade QStashService to support explicit initialization and improved error handling ([f0481f2](https://github.com/YoungSx/drive-collector-js/commit/f0481f2024698159521fda76cf21d5d655aaad5b))


### 🐛 问题修复

* adds config display and improves Infisical client timeout handling ([d2a7255](https://github.com/YoungSx/drive-collector-js/commit/d2a725536178ddfb900b7b5701483aab9ba72426))
* prevent CacheService heartbeat timer in tests to eliminate open handles ([1040ac8](https://github.com/YoungSx/drive-collector-js/commit/1040ac8cb12d39624a669a60fc243f1af8efe3a8))
* resolve InstanceCoordinator test timeouts by intercepting setInterval ([6b62c21](https://github.com/YoungSx/drive-collector-js/commit/6b62c2110d79acdf21fc8e06a3bc5d50d97d251f))


### 🔧 其他任务

* improves Telegram error handling by adding FloodWaitError support ([5eccc14](https://github.com/YoungSx/drive-collector-js/commit/5eccc145262b618621db1a095dafe71d55d6ca8f))

### [4.7.1](https://github.com/YoungSx/drive-collector-js/compare/v4.7.0...v4.7.1) (2026-01-03)


### 🐛 问题修复

* improves error handling and data serialization in logger service ([49ff0ee](https://github.com/YoungSx/drive-collector-js/commit/49ff0ee9ccd24f99303da8b136f2593296780260))
* improves rate limiting and recovery strategies ([60e400c](https://github.com/YoungSx/drive-collector-js/commit/60e400cd7c36d964a94924f374f25d4011743a6e))

## [4.7.0](https://github.com/YoungSx/drive-collector-js/compare/v4.6.1...v4.7.0) (2026-01-03)


### 🐛 问题修复

* adds connection status callback functionality ([5b2c95c](https://github.com/YoungSx/drive-collector-js/commit/5b2c95c6abe1c33f128e1493cbb506c7dcf11f72))


### ✨ 新特性

* enhance environment variable management and Docker configuration ([d284986](https://github.com/YoungSx/drive-collector-js/commit/d28498636a8a336bdfb6ca77f9201bed86428ec0))

### [4.6.1](https://github.com/YoungSx/drive-collector-js/compare/v4.6.0...v4.6.1) (2026-01-03)


### ✅ 测试相关

* adds tests for logger field limiting and payload security ([63f8c9c](https://github.com/YoungSx/drive-collector-js/commit/63f8c9c6bfc1302075d6935ed87d38de5a14249e))
* improves test and service cleanup for Redis and Telegram clients ([46d5778](https://github.com/YoungSx/drive-collector-js/commit/46d5778bc91ab009fa197d87e6a64d18c7395448))


### 🐛 问题修复

* enhance Telegram error handling with comprehensive classification and recovery strategies ([b4c503e](https://github.com/YoungSx/drive-collector-js/commit/b4c503e2f1d07c1cca9bed37d3d0532229a959c5))
* enhances Axiom logging with field limits and error handling ([1a747b7](https://github.com/YoungSx/drive-collector-js/commit/1a747b71a3b0edd5afefa4aa5b8d0accfd69ed93))

## [4.6.0](https://github.com/YoungSx/drive-collector-js/compare/v4.5.7...v4.6.0) (2026-01-03)


### ♻️ 代码重构

* CacheService ([517248c](https://github.com/YoungSx/drive-collector-js/commit/517248cdf37f293c9340db67b78b33a07c37dc85))


### 🐛 问题修复

* CacheService.test.js ([3c70848](https://github.com/YoungSx/drive-collector-js/commit/3c708487cd729f7aa73efded424e0ca29993a4e5))
* recursive call output ([6468fb7](https://github.com/YoungSx/drive-collector-js/commit/6468fb7fa615a88954e06d489421c4d7f93a0afc))


### ✅ 测试相关

* improve test reliability and fix mocking issues ([3e351b4](https://github.com/YoungSx/drive-collector-js/commit/3e351b46f9641b2eaf719bd27534cf0cabb08df1))

### [4.5.7](https://github.com/YoungSx/drive-collector-js/compare/v4.5.6...v4.5.7) (2026-01-03)


### 🐛 问题修复

* enables concurrent restart prevention test ([84a24e2](https://github.com/YoungSx/drive-collector-js/commit/84a24e229037e0e3df758a160b85ea2e9aba2b5c))
* improve CacheService reliability and fix race conditions ([2dfb12d](https://github.com/YoungSx/drive-collector-js/commit/2dfb12d9f00a896f20447d47b5dd1ee8fd011bc8))
* improves failover mechanism and error handling for Upstash integration ([35ebe8f](https://github.com/YoungSx/drive-collector-js/commit/35ebe8fc56088c26113b3db3abfe04e545373c71))
* improves instance unregistration error handling ([0f72b85](https://github.com/YoungSx/drive-collector-js/commit/0f72b85f182629a62f711db2dabc035387c878ff))
* Redis connection management and event handling ([ad78d68](https://github.com/YoungSx/drive-collector-js/commit/ad78d68ef3412a8f1f2f24a71399401345ca642e))

### [4.5.6](https://github.com/YoungSx/drive-collector-js/compare/v4.5.5...v4.5.6) (2026-01-03)


### 🔧 其他任务

* add d1 disgnostic scripts ([d12dad2](https://github.com/YoungSx/drive-collector-js/commit/d12dad25987a96d2a6b93055a92bc1032710f643))


### 🐛 问题修复

* context binding for async callbacks in CacheService ([f0878c3](https://github.com/YoungSx/drive-collector-js/commit/f0878c3f08d6fc073c3c966268ba7e52c9c549c1))
* improves Redis recovery test stability and adds heartbeat stop method ([4c2065e](https://github.com/YoungSx/drive-collector-js/commit/4c2065e986b2add766447fb70ec3932d53f4dd5e))
* improves test cleanup and logger initialization robustness ([39365fb](https://github.com/YoungSx/drive-collector-js/commit/39365fbfc1bb184ce4f4eacda7335628902fe6ac))
* resolve test timeouts in rclone.test.js by adjusting event timing with Jest fake timers ([1d02ba5](https://github.com/YoungSx/drive-collector-js/commit/1d02ba5ad01751f16b01402c5959c7197fe93d6f))
* **services/d1:** remove incorrect KV token fallback ([9f12366](https://github.com/YoungSx/drive-collector-js/commit/9f123669788f9a83029c48ba6548c208460a21cd))
* **tests:** resolve limiter.test.js timeout via timer mocks and advancement ([1a20b78](https://github.com/YoungSx/drive-collector-js/commit/1a20b78a26d92d8592daab32156ebbd7e60b458a))

### [4.5.5](https://github.com/YoungSx/drive-collector-js/compare/v4.5.4...v4.5.5) (2026-01-02)


### 🐛 问题修复

* **cache:** resolve Upstash WRONGPASS auth failure with fallback ([a249a74](https://github.com/YoungSx/drive-collector-js/commit/a249a74b5bcd9e3730765f953fbb5cc9a1ccbd54))
* moves ioredis from devDependencies to dependencies ([acc6769](https://github.com/YoungSx/drive-collector-js/commit/acc676962f884846d4c639441d46f792540d7eb1))


### 🔧 其他任务

* remove backup file ([20511de](https://github.com/YoungSx/drive-collector-js/commit/20511de642a52cf0b6e6bfe2d1036880720b129a))

### [4.5.4](https://github.com/YoungSx/drive-collector-js/compare/v4.5.1...v4.5.4) (2026-01-02)


### 🔧 其他任务

* improves message handling logging for unknown events ([06a88d5](https://github.com/YoungSx/drive-collector-js/commit/06a88d5c5fcdd4cee5140bcd5690b7d07bcb0712))
* **release:** 4.5.2 ([de741ac](https://github.com/YoungSx/drive-collector-js/commit/de741ac20a282e16af97e406a6df1514617b3a3b))
* **release:** 4.5.3 ([9911217](https://github.com/YoungSx/drive-collector-js/commit/99112172cd691f060a4d7eb8bb1effd9ec55220c))


### 🐛 问题修复

* add mockClear and mockResolvedValue in logger.test.js for test isolation ([41eb86f](https://github.com/YoungSx/drive-collector-js/commit/41eb86f19459bd044e41362379c9255b707bd7b6))
* adds Redis token authentication support ([df726e9](https://github.com/YoungSx/drive-collector-js/commit/df726e9b90eb021822d5f34df66fb795b013adcf))
* adds retry limit to Telegram client lock acquisition ([bfd61ab](https://github.com/YoungSx/drive-collector-js/commit/bfd61ab12eacb741614b16666b7fa92316e7602b))
* adds safe serialization for unknown events ([3214a82](https://github.com/YoungSx/drive-collector-js/commit/3214a8257865a04978d5707efb989ab909d3aee4))
* improves event serialization robustness ([4ce9d8c](https://github.com/YoungSx/drive-collector-js/commit/4ce9d8c999bd47367b71f44ded6d9ad19a7abde3))
* robustify logger telegram proxy test against extraneous ingest calls ([4f950f6](https://github.com/YoungSx/drive-collector-js/commit/4f950f6662a05f4c655f9428eeba7b606ff26c35))

### [4.5.3](https://github.com/YoungSx/drive-collector-js/compare/v4.5.2...v4.5.3) (2026-01-01)


### 🐛 问题修复

* improves event serialization robustness ([4ce9d8c](https://github.com/YoungSx/drive-collector-js/commit/4ce9d8c999bd47367b71f44ded6d9ad19a7abde3))

### [4.5.2](https://github.com/YoungSx/drive-collector-js/compare/v4.5.1...v4.5.2) (2026-01-01)


### 🔧 其他任务

* improves message handling logging for unknown events ([06a88d5](https://github.com/YoungSx/drive-collector-js/commit/06a88d5c5fcdd4cee5140bcd5690b7d07bcb0712))


### 🐛 问题修复

* adds retry limit to Telegram client lock acquisition ([bfd61ab](https://github.com/YoungSx/drive-collector-js/commit/bfd61ab12eacb741614b16666b7fa92316e7602b))
* adds safe serialization for unknown events ([3214a82](https://github.com/YoungSx/drive-collector-js/commit/3214a8257865a04978d5707efb989ab909d3aee4))

### [4.5.1](https://github.com/YoungSx/drive-collector-js/compare/v4.5.0...v4.5.1) (2026-01-01)


### 🐛 问题修复

* enhances QStash publish test script with verbose debugging and raw HTTPS testing ([c336e8f](https://github.com/YoungSx/drive-collector-js/commit/c336e8f438d2fc5ab54649928580e480b6dd8733))

## [4.5.0](https://github.com/YoungSx/drive-collector-js/compare/v4.4.5...v4.5.0) (2026-01-01)


### 🐛 问题修复

* improves D1 error handling and logging with detailed error information ([4cf2a05](https://github.com/YoungSx/drive-collector-js/commit/4cf2a05903523608b8af793c850093640c04b288))
* improves test robustness by filtering irrelevant log calls ([ce23902](https://github.com/YoungSx/drive-collector-js/commit/ce23902c71e6c825eb53449de64ed4c62d447a0d))


### 🔧 其他任务

* cleanup wrangler.toml unused lb configs ([b91ffa3](https://github.com/YoungSx/drive-collector-js/commit/b91ffa349ff7024513afa35548195bc88fd64968))


### ✅ 测试相关

* qstash ([b033a1b](https://github.com/YoungSx/drive-collector-js/commit/b033a1b5d04a3e4000a74fde3e43ff4c2c40a336))

### [4.4.5](https://github.com/YoungSx/drive-collector-js/compare/v4.4.4...v4.4.5) (2026-01-01)


### ✅ 测试相关

* enhances DriveRepository with improved cache handling and error resilience ([067e466](https://github.com/YoungSx/drive-collector-js/commit/067e4668640a37abf41bb884c84f2579fd746ad6))


### 🐛 问题修复

* implement Read-Through and Write-Through caching with D1 persistence ([eec639a](https://github.com/YoungSx/drive-collector-js/commit/eec639aad52026778bcbe93ced9ef4077f57bf79))
* improves DriveRepository error handling and type safety ([fdf77a9](https://github.com/YoungSx/drive-collector-js/commit/fdf77a97f5b2962dd4a020f06961581126173f8e))

### [4.4.4](https://github.com/YoungSx/drive-collector-js/compare/v4.4.3...v4.4.4) (2026-01-01)


### 🐛 问题修复

* improves Redis client initialization with state tracking and fallback handling ([911b45a](https://github.com/YoungSx/drive-collector-js/commit/911b45a957dbb962032c3a8448bf3ad707f49bc5))

### [4.4.3](https://github.com/YoungSx/drive-collector-js/compare/v4.4.2...v4.4.3) (2026-01-01)

### [4.4.2](https://github.com/YoungSx/drive-collector-js/compare/v4.4.1...v4.4.2) (2026-01-01)


### 🚀 性能优化

* add performance monitoring logs for message processing latency ([27333ec](https://github.com/YoungSx/drive-collector-js/commit/27333ecfafa94ac784e59a58fe71916c534951b9))


### 🔧 其他任务

* improves cache system resilience and reduces error verbosity ([18b3536](https://github.com/YoungSx/drive-collector-js/commit/18b3536b03004b396c660b436825c4ca2296df9d))


### 🐛 问题修复

* adds explicit TLS configuration logic for Redis ([6da1f9b](https://github.com/YoungSx/drive-collector-js/commit/6da1f9b37beb41a23b7b271c98c3ef27525fa3b8))
* cache test script ([c53fd6d](https://github.com/YoungSx/drive-collector-js/commit/c53fd6d048e4e13ba4dd5409ffea04a125623154))
* complete cache test script ([06940e5](https://github.com/YoungSx/drive-collector-js/commit/06940e566c358ed7c6f59d02319fad3d9741b3ff))
* enhance Redis TLS configuration and add performance diagnostics ([c085540](https://github.com/YoungSx/drive-collector-js/commit/c085540eb651d2675e33d843c821c89566c8ad76))
* revert removal of default username in Redis URL to ensure compatibility ([f675c38](https://github.com/YoungSx/drive-collector-js/commit/f675c38d6f203118b3cb33bdf10d7143a43da8df))
* unifies Redis configuration and improves TLS/SNI handling ([8e53bb2](https://github.com/YoungSx/drive-collector-js/commit/8e53bb2ad6d3701b1800a22930dceb925b17060b))

### [4.4.1](https://github.com/YoungSx/drive-collector-js/compare/v4.4.0...v4.4.1) (2025-12-31)


### ✅ 测试相关

* cache provider ([1e33566](https://github.com/YoungSx/drive-collector-js/commit/1e3356672fe90434e133349ffd8a30303b2ef9c2))


### 🐛 问题修复

* Fixes Cloudflare token configuration to avoid incorrect provider detection ([0101401](https://github.com/YoungSx/drive-collector-js/commit/0101401480424a273aed0449625b512252b8e58a))

## [4.4.0](https://github.com/YoungSx/drive-collector-js/compare/v4.3.1...v4.4.0) (2025-12-31)


### 🐛 问题修复

* resolve telegram lock false loss due to KV eventual consistency ([02d07cf](https://github.com/YoungSx/drive-collector-js/commit/02d07cf11f2b1f0a8b05669ea00398636e6ea866))


### ✨ 新特性

* add cache provider identification to log messages ([023d2ff](https://github.com/YoungSx/drive-collector-js/commit/023d2ff1328768e61213a72c7a0f9536028769f0))

### [4.3.1](https://github.com/YoungSx/drive-collector-js/compare/v4.3.0...v4.3.1) (2025-12-31)


### 🚀 性能优化

* optimize jest test performance with parallel execution and mock caching ([8993439](https://github.com/YoungSx/drive-collector-js/commit/89934395b04a657cc14136fd859f88ffbbba5d75))


### 🐛 问题修复

* improves Redis configuration validation and fallback handling ([c1fe663](https://github.com/YoungSx/drive-collector-js/commit/c1fe663612c1fcbb1cf71089af55633fafbc0a9d))
* improves Telegram client proxy with better method delegation ([e64100b](https://github.com/YoungSx/drive-collector-js/commit/e64100b60c9363892752e25dc06aa5fea2aeacc9))
* improves test reliability and performance ([ebc8259](https://github.com/YoungSx/drive-collector-js/commit/ebc8259bfbffaf43620434c2219194e9470afdb7))
* **telegram:** unify TIMEOUT errors to Axiom with enhanced proxy and structured logging ([bd7c043](https://github.com/YoungSx/drive-collector-js/commit/bd7c043607d7af260475365d75c33d409cc50a9b))
* unified telegram timeout logging to Axiom and resolved test memory leak ([f36ca41](https://github.com/YoungSx/drive-collector-js/commit/f36ca414574a8f4ed5e65c3c8fd51f5cc5a6e38d))

## [4.3.0](https://github.com/YoungSx/drive-collector-js/compare/v4.2.3...v4.3.0) (2025-12-31)


### 🔧 其他任务

* improves logger instance ID fallback handling ([3e6e726](https://github.com/YoungSx/drive-collector-js/commit/3e6e7265f9bcc1c8b20bee02b60995976030e770))


### ✨ 新特性

* add Redis TLS configuration and connection diagnostics ([668e07d](https://github.com/YoungSx/drive-collector-js/commit/668e07d7e28cccca0bf41ede8e186cd39eb92fa9))
* enhances Telegram client stability with circuit breaker pattern ([673ff08](https://github.com/YoungSx/drive-collector-js/commit/673ff080e659f467cb53e9a5a94b88bc1d1a98bc))
* improves Redis configuration flexibility and TLS support ([094fd3c](https://github.com/YoungSx/drive-collector-js/commit/094fd3c075d877c9c373b99db58b4e476fe6b3bc))
* **telegram:** enhance timeout config and monitoring ([22d2174](https://github.com/YoungSx/drive-collector-js/commit/22d217497a136eaedb8af136e670ae331d288854))


### 🐛 问题修复

* enhances Redis configuration and test setup for CacheService ([fe54a7b](https://github.com/YoungSx/drive-collector-js/commit/fe54a7b6ba66409642ba6314b492c886bc06cc1e))
* enhances Telegram client stability with health monitoring and error handling ([b33738a](https://github.com/YoungSx/drive-collector-js/commit/b33738afa2fdbf7ad88502c85bba9d970bb361d2))
* improves Redis connection resilience with configurable retry and restart logic ([6cf6ca2](https://github.com/YoungSx/drive-collector-js/commit/6cf6ca2de66989840ae3d646b0c55c6ad7ee77ac))
* removes Redis and Telegram debugging scripts ([1cf8390](https://github.com/YoungSx/drive-collector-js/commit/1cf839055feb75f607842235de2f49f215cdb0b8))
* resolve Telegram updates timeout by improving reconnection logic and watchdog ([814d5d8](https://github.com/YoungSx/drive-collector-js/commit/814d5d82dfbb69afa36eee14eb25803d053850f8))
* updates cache service to handle null Redis client safely ([f2ac271](https://github.com/YoungSx/drive-collector-js/commit/f2ac271e21579317eca762ffe35ee618f0ce710d))


### ♻️ 代码重构

* improves error handling and retry logic across services ([78223ad](https://github.com/YoungSx/drive-collector-js/commit/78223ad5b96c35b19e4f60700c3b7b9d160f507c))

### [4.2.3](https://github.com/YoungSx/drive-collector-js/compare/v4.2.2...v4.2.3) (2025-12-30)


### ✨ 新特性

* add canSend method to logger service ([dde7eda](https://github.com/YoungSx/drive-collector-js/commit/dde7edaf0aca256b717312a56912eb9a96be66cb))
* optimize Redis connection config for Northflank environment ([8143b03](https://github.com/YoungSx/drive-collector-js/commit/8143b030530f2a001dae240de31bf2019728aa7b))


### 🔧 其他任务

* install ping in Dockerfile ([de42fad](https://github.com/YoungSx/drive-collector-js/commit/de42fad9348ade811d93569d0ef9acaaefab823d))


### 🐛 问题修复

* adds cleanup and resource management for test and diagnostic scripts ([62f87f0](https://github.com/YoungSx/drive-collector-js/commit/62f87f0c94f9e45368eea94d3cf9945244c2f6ad))
* adds waitForReady method for Redis client state management ([da76066](https://github.com/YoungSx/drive-collector-js/commit/da76066ebd403e38f3f33eaa6e17eec4657a2df0))
* allow scripts in .dockerignore ([1a43bd1](https://github.com/YoungSx/drive-collector-js/commit/1a43bd117d58b76e821c83677ad9c39bf8830d09))
* optimize CacheService failover and testing infrastructure ([5e5747e](https://github.com/YoungSx/drive-collector-js/commit/5e5747edb314f66a99e1bfb1e05e0df7a7902c48))
* optimize redis connection parameters and add heartbeat for Northflank ([77a8544](https://github.com/YoungSx/drive-collector-js/commit/77a854401f7f9158308a6719a09d6fde06bdb180))
* resolve container startup failure by fixing circular dependency and moving better-sqlite3 to dependencies ([cdd5e72](https://github.com/YoungSx/drive-collector-js/commit/cdd5e7221a729e81b3b4f59886322200e7a5985d))
* resolve Redis connection diagnostic script hang issue ([69b11c5](https://github.com/YoungSx/drive-collector-js/commit/69b11c5aee665c3971f8092bbdc73bec4051f20b))
* resolve Redis connection diagnostic script hang issue ([4abdde6](https://github.com/YoungSx/drive-collector-js/commit/4abdde6ced06ab6425f3d70457878bed4da82853))
* resolve Redis connection diagnostic script hang issue ([dbde457](https://github.com/YoungSx/drive-collector-js/commit/dbde4572758da65a29bbb460eaeae3ae72edf47a))

## [4.2.2](https://github.com/YoungSx/drive-collector-js/compare/v4.2.1...v4.3.0) (2025-12-30)


### 🔧 其他任务

* install dotenv ([96190bc](https://github.com/YoungSx/drive-collector-js/commit/96190bc14735f86e87f6c7e831a9a6e205bdc126))


### ✨ 新特性

* enhance cache test coverage and improve provider handling ([6696d97](https://github.com/YoungSx/drive-collector-js/commit/6696d972acb49415a70872cf6786cf763ebb81d8))


### ✅ 测试相关

* add some test scripts to prod ([942afd9](https://github.com/YoungSx/drive-collector-js/commit/942afd90a4c05c44f5ab0da1109dd21b6a5cab3c))
* adds comprehensive cache service test script ([ed879d5](https://github.com/YoungSx/drive-collector-js/commit/ed879d57c8a94f491dbc0daeb0f1d077a6f40f15))


### 🐛 问题修复

* adds error handling for InstanceCoordinator startup ([01852de](https://github.com/YoungSx/drive-collector-js/commit/01852de9a6ad386d07568adb7c7fad4fc7fcfe7f))
* adds uncaught exception and unhandled rejection handlers ([0d0fb5f](https://github.com/YoungSx/drive-collector-js/commit/0d0fb5f225f96c15996a9444fe503c15f76d2e66))
* consolidates TTL conversion logic across cache services ([bb8327b](https://github.com/YoungSx/drive-collector-js/commit/bb8327b8be1a5b053de4062fdf5ecaa653cf2285))
* update TTL parameter in testTTLVerification to use seconds instead of milliseconds ([3f1c35f](https://github.com/YoungSx/drive-collector-js/commit/3f1c35f0219c72d55b959c9c2564307dc6f44e2c))

### [4.2.1](https://github.com/YoungSx/drive-collector-js/compare/v4.2.0...v4.2.1) (2025-12-30)


### 🐛 问题修复

* improves Telegram client initialization and connection management ([4e6b53c](https://github.com/YoungSx/drive-collector-js/commit/4e6b53c3d1f0d654eeaa6fa0b447fa3e15a58984))

## [4.2.0](https://github.com/YoungSx/drive-collector-js/compare/v4.1.0...v4.2.0) (2025-12-30)


### ✨ 新特性

* unify QStash configuration and enhance validation ([cc64a8c](https://github.com/YoungSx/drive-collector-js/commit/cc64a8c783a3fad06d35cc339d54ee92f7df944b))

## [4.1.0](https://github.com/YoungSx/drive-collector-js/compare/v4.0.2...v4.1.0) (2025-12-30)


### ✨ 新特性

* add telegram proxy support and enhance connection stability ([5ddb672](https://github.com/YoungSx/drive-collector-js/commit/5ddb672eebb635dea3ecb54fd69f3a0479f8c906))

### [4.0.2](https://github.com/YoungSx/drive-collector-js/compare/v4.0.1...v4.0.2) (2025-12-30)


### 🔧 其他任务

* fix package-lock.json version ([c0cfeed](https://github.com/YoungSx/drive-collector-js/commit/c0cfeedbdde84d205c748a408582de32ccb0c67f))
* update clinerules and versionrc configuration ([4c22b4f](https://github.com/YoungSx/drive-collector-js/commit/4c22b4f23b3b224b3c5c914c643b1168f6609ad7))

### [4.0.1](https://github.com/YoungSx/drive-collector-js/compare/v4.0.0...v4.0.1) (2025-12-30)


### 🔧 其他任务

* update version and fix ci ([f2c96e0](https://github.com/YoungSx/drive-collector-js/commit/f2c96e04ab3137e0393d86cb6fdf106be7b7199f))

### [3.3.0](https://github.com/YoungSx/drive-collector-js/compare/v3.2.4...v3.3.0) (2025-12-30)

#### ✨ Features

* **OSS Helper**: 新增 S3/R2 分片上传辅助工具，支持进度回调和公共 URL 生成 ([new file](src/utils/oss-helper.js))
* **CI/CD Pipeline**: 完整的 GitHub Actions 工作流，包含测试、构建、Docker 镜像推送和通知 ([.github/workflows/ci.yml])
* **Release Automation**: AI 驱动的发布脚本，支持语义化版本和 Conventional Commits ([scripts/release-ai.js])
* **Environment Setup**: 新增完整的环境变量示例文件，包含所有支持的配置项 ([.env.example])
* **Documentation**: 新增中文 README 文档，完善项目说明和使用指南 ([docs/README_CN.md])
* **Configuration**: 新增 Wrangler 配置文件，支持 Cloudflare Workers 部署 ([wrangler.toml, wrangler.build.toml])
* **Version Management**: 新增 .versionrc.json 配置，标准化版本发布流程

#### 🔧 Improvements

* **Rate Limiting**: 优化限流器自动扩缩容逻辑，增强 429 错误处理和断开连接检测
  - 提升最大重试次数从 3 到 10
  - 改进指数退避算法，增加抖动防止同步
  - 优化本地冷却期检查，减少 KV 同步频率
* **Logger**: 统一使用 logger 服务替代 console，增强日志结构和版本跟踪
* **Dispatcher**: 改进消息编辑错误处理，使用 logger 替代 console.warn
* **Dependencies**: 新增 AWS SDK 依赖 (@aws-sdk/client-s3, @aws-sdk/lib-storage) 用于 OSS 支持

#### 📝 Documentation

* **README**: 更新项目描述，添加功能特性和架构说明
* **CI/CD**: 完善 CI 工作流文档，包含性能指标和构建优化说明

#### 🔧 Maintenance

* **Test Infrastructure**: 更新测试配置，确保与新功能兼容
* **Docker**: 优化 .dockerignore，移除不必要的文件

### [3.2.4](https://github.com/YoungSx/drive-collector-js/compare/v3.2.2...v3.2.4) (2025-12-29)


### 🐛 问题修复

* resolve 429 error retry mechanism deadlock ([595d991](https://github.com/YoungSx/drive-collector-js/commit/595d991e97ed38aff14f744c28b7bacae6f038f7))

### [3.2.2](https://github.com/YoungSx/drive-collector-js/compare/v3.2.1...v3.2.2) (2025-12-29)


### 🐛 问题修复

* resolve 429 retry exhaustion on startup with improved rate limiting ([6961c5d](https://github.com/YoungSx/drive-collector-js/commit/6961c5d8d767439225ab904aaa13f6f75a3ea352))

### [3.2.1](https://github.com/YoungSx/drive-collector-js/compare/v3.2.0...v3.2.1) (2025-12-29)


### 📝 文档更新

* update CHANGELOG.md and fix test for release script ([0f5f12a](https://github.com/YoungSx/drive-collector-js/commit/0f5f12a91299e7494f5aa17a350d90241945a1d6))


### ✨ 新特性

* **scripts:** adapt release-ai to latest standards ([b53d6bb](https://github.com/YoungSx/drive-collector-js/commit/b53d6bb4f419281908d52e9a61d6036404ce75d1))

### [3.2.0](https://github.com/YoungSx/drive-collector-js/compare/v3.1.2...v3.2.0) (2025-12-30)

#### ✨ Features

* **DriveRepository**: 实现基于 KV 的活跃网盘列表管理功能，支持 `findAll()` 方法返回所有活跃网盘配置 ([d9c1091](https://github.com/YoungSx/drive-collector-js/commit/d9c109123f5acb5bf468376a80dc78e3db2d612c))

#### 🔧 Refactoring

* **Release Script**: 优化 release-ai.js 与 standard-version 的集成，移除冗余函数，简化发布流程 ([4086754](https://github.com/YoungSx/drive-collector-js/commit/40867549a8429fe82e93fd451d486e149c8ec881))

#### 🐛 Bug Fixes

* **InstanceCoordinator**: 增强锁检查机制，处理 KV 限流和网络错误，避免错误的锁丢失判断
* **Telegram Service**: 改进连接问题处理，在锁检查失败时暂缓重连，防止竞争条件

#### 🔧 Maintenance

* **测试修复**: 更新 DriveRepository 测试以适配新的活跃网盘列表功能
* **配置更新**: 同步更新 manifest.json 中的 driveRepository 配置和可靠性参数

### [3.1.0](https://github.com/YoungSx/drive-collector-js/compare/v3.0.2...v3.1.0) (2025-12-29)


### ✨ Features

* **日志系统**: 添加版本跟踪功能，支持从环境变量或 package.json 动态读取版本号，所有日志消息现在都会包含版本前缀 `[vX.X.X]`，便于问题追踪和版本识别

### 🐛 Bug Fixes

* **发布流程**: 修复 release-ai 脚本问题，确保版本发布流程正常工作
* **Telegram 连接**: 增强 Telegram 锁续期机制，添加双重检查和抖动处理，提升连接稳定性
* **OSS 上传**: 修复在 Node.js 18 环境下 OSS Worker 上传问题，使用 `fs.readFileSync` 替代 `createReadStream`

### 🔧 Maintenance

* **依赖升级**: 升级 Node 运行时至 ^20.0.0，确保依赖兼容性
* **CI/CD 优化**:
  - 移除 Node 18.x 测试矩阵，仅保留 20.x
  - 添加性能指标跟踪到 CI 工作流
  - 实现基于 GitHub App 的自动化 manifest 同步工作流
  - 添加生产环境和 Bark Webhook 配置
  - 增强 GitHub Actions 工作流，包含矩阵测试和 Docker 构建优化

### [3.0.2](https://github.com/YoungSx/drive-collector-js/compare/v3.0.1...v3.0.2) (2025-12-29)


### 📝 文档更新

* add conventional commits guideline to clinerules ([09d0227](https://github.com/YoungSx/drive-collector-js/commit/09d02271e001dd67744428cea3a95b5745778d8b))
* organize CHANGELOG.md: unify format, clear exceptions, and complete 6 missing Git tag versions (v3.0.1~v2.3.5), summarize changes based on commit logs ([fb46627](https://github.com/YoungSx/drive-collector-js/commit/fb466278241accd8298688f54f3594117206059c))
* update clinerules with enhanced guidelines for production quality and manifest sync ([8f70623](https://github.com/YoungSx/drive-collector-js/commit/8f7062324de2bbc4301b736aabc15dbe9f5149c3))


### 🐛 问题修复

* ensure lock ownership during Telegram reconnection and handle AUTH_KEY_DUPLICATED ([fb465a1](https://github.com/YoungSx/drive-collector-js/commit/fb465a16a67fee1b890c530eed762b7284d04d26))
* handle telegram binaryreader undefined stream error ([269bf45](https://github.com/YoungSx/drive-collector-js/commit/269bf45bf79d971ce3a2c85ebcb9e5aa61fc29ce))


### 🔧 其他任务

* bump version to 3.0.1 and enhance release automation ([6be3853](https://github.com/YoungSx/drive-collector-js/commit/6be38531e8017c2d89aad44c807c479d4c611c6b))
* initialize project manifest with architecture blueprint ([c31d59a](https://github.com/YoungSx/drive-collector-js/commit/c31d59ac937c3e970b878e09dd8a29aaf4e419fb))

## [3.0.1] - 2025-12-25

### ✨ Features
- **诊断增强**：添加系统诊断命令，实现诊断报告渲染，增强命令结构。
- **服务管理**：实现 `getAllInstances` 方法，增强实例管理能力。
- **任务队列**：在创建时立即将任务入队到 QStash。

### 🐛 Bug Fixes
- **Telegram 看门狗**：增强看门狗以处理时钟漂移、断开连接状态监控和状态重置。
- **错误处理**：增强错误处理和客户端连接检查。

### 🔧 Maintenance
- **构建流程**：添加条件化镜像推送至 ghcr.io，仅在标签推送时进行条件化构建。
- **日志系统**：用结构化日志服务替换 console.*，提升日志质量。
- **文档更新**：添加 QStash 集成和 Cloudflare LB 文档，添加 .env.example。
- **性能测试**：添加性能测试脚本，优化测试监控。

## [3.0.0] - 2025-12-25

### ✨ Features
- **架构升级**：重大架构重构，将 bot/worker 解耦为 dispatcher/processor，引入 D1 任务队列和 R2 三层上传架构。
- **QStash 集成**：用 QStash 入队替换内部队列，实现分布式任务处理。
- **服务管理**：添加服务管理命令 `/open_service` 和 `/close_service`。
- **Telegram 增强**：添加 Telegram 客户端状态回调和连接管理。

### 🔧 Maintenance
- **依赖更新**：添加 OSS 客户端/存储支持。
- **构建优化**：添加 esbuild 和 wrangler 配置。
- **测试修复**：重构测试以适应新架构，增强错误处理测试。

## [2.4.1] - 2025-12-25

### ✅ Testing
- **测试重构**：更新 TaskManager 测试以使用 DatabaseService，重构 DriveRepository 测试以使用 KV 代替 D1。

## [2.4.0] - 2025-12-25

### ✨ Features
- **架构重构**：将 bot/worker 解耦为 dispatcher/processor，使用 D1 任务队列和 R2 三层上传架构。
- **管理命令**：添加 `/status_public` 和 `/status_private` 管理命令。
- **错误恢复**：为启动和 D1 添加错误处理和重试逻辑，防止启动期间的重入。

### 🔧 Maintenance
- **依赖管理**：添加 esbuild 和 wrangler 用于 Cloudflare Workers 构建。
- **测试优化**：解决 19 个失败的测试并优化执行时间。
- **错误处理**：增强 KVService 错误处理和测试工具。

## [2.3.6] - 2025-12-25

### ✨ Features
- **诊断系统**：实现系统诊断报告渲染，增强诊断报告格式和错误处理。
- **Telegram 连接**：添加连接看门狗和心跳机制，提升连接稳定性。
- **任务显示**：增强聚焦任务的进度显示和任务 ID 显示。

### 🐛 Bug Fixes
- **任务队列 UI**：修复任务队列 UI 稳定性和 TypeError，提升用户体验。
- **文件验证**：改进文件验证和远程大小检测，使用实际本地文件名进行上传验证一致性。
- **错误处理**：增强错误处理和进度条边界，处理重复认证密钥。

### 🔧 Maintenance
- **测试框架**：实现 TaskManager 工作器的重入保护，添加 Dispatcher 回调和消息处理器测试。
- **性能优化**：改进 Rclone 版本解析，简化 UIHelper 状态和进度显示。

## [2.3.5] - 2025-12-25

### ✨ Features
- **任务队列增强**：增强任务队列状态，包含上传处理计数，提升任务监控能力。
- **诊断功能**：添加 `/diagnosis` 命令用于管理员网络诊断，便于问题排查。

### 🐛 Bug Fixes
- **任务管理器稳定性**：修复 TaskManager 中的字符串插值问题，确保消息格式正确。
- **文件验证**：增强文件验证鲁棒性和错误处理，提升系统稳定性。

### 🔧 Maintenance
- **测试增强**：添加 TaskManager 并发和错误处理测试，提升代码质量。
- **文档更新**：从支持的链接类型中移除 Google Drive，更新文档准确性。

## [2.3.4] - 2025-12-25

### 🐛 Bug Fixes

* **任务队列稳定性**：修复了在任务状态频繁变动时可能发生的 `TypeError: Cannot read properties of undefined (reading 'isGroup')` 错误。通过在 `updateQueueUI` 中引入任务快照机制并增加非空检查，显著提升了高并发场景下队列 UI 更新的鲁棒性。

## [2.3.3] - 2025-12-25

### 🐛 Bug Fixes

* **任务监控看板**：修复了在刷新组任务状态时发生的 `ReferenceError: safeEdit is not defined` 错误。通过在 `TaskManager.js` 中正确导入 `safeEdit` 工具函数，确保了媒体组（Album）任务进度的实时更新稳定性。

## [2.3.2] - 2025-12-25


### 🔧 Maintenance

* finalize atomic AIVM workflow for clean git history ([9bf5cd5](https://github.com/YoungSx/drive-collector-js/commit/9bf5cd50a08337109c26e6b8a2057897f199e907))


### ✅ Testing

* 为内存泄漏修复添加测试用例 ([062c8e1](https://github.com/YoungSx/drive-collector-js/commit/062c8e1acb5649739b5206e21b5e2d9f681d4524))


### 🚀 Performance

* 修复内存泄漏风险，在TaskRepository中添加定期清理机制 ([0bccdbc](https://github.com/YoungSx/drive-collector-js/commit/0bccdbcff1487503b7561087b868d25aea1534bb))
* 优化错误处理，移除空的catch块并提供详细错误信息 ([4a34883](https://github.com/YoungSx/drive-collector-js/commit/4a348837a5088bba99fdc4d5a940714ca47e541b))
* 优化缓存策略，基于文件变化频率动态调整缓存时间 ([b63e338](https://github.com/YoungSx/drive-collector-js/commit/b63e33885d3ae5c6fcc8c4f44f58c89ae542c7fc))
* 优化数据库批量操作，在任务恢复时使用批量更新和并发处理 ([616811e](https://github.com/YoungSx/drive-collector-js/commit/616811e4fa6ae94a0017d71b0982797548b67293))
* 优化文件处理，替换同步文件操作为异步操作 ([08b0960](https://github.com/YoungSx/drive-collector-js/commit/08b096099d51eac18317a50cce19e5b68efcf89c))
* 优化限流器性能，消除CPU浪费的while循环 ([1c8156f](https://github.com/YoungSx/drive-collector-js/commit/1c8156f83785a939a4fde97ac20f0a8d3ab4b860))
* 优化循环性能，在updateQueueUI中使用更高效的延迟控制 ([e61d04c](https://github.com/YoungSx/drive-collector-js/commit/e61d04c4c74228dde5c99e5b049342003c673829))
* 优化预加载数据，提升系统启动性能 ([1e5c42b](https://github.com/YoungSx/drive-collector-js/commit/1e5c42b8a28ce0e577d3e9b35c6e6beea581cd1c))
* 优化DriveRepository查询性能 - 为findAll()添加5分钟缓存机制 ([79b1133](https://github.com/YoungSx/drive-collector-js/commit/79b113335062cdceb00db077e27de8988fc2e4ef))
* 优化TaskManager初始化 - 实现异步操作并行化，提升启动性能 ([4390f57](https://github.com/YoungSx/drive-collector-js/commit/4390f575dfcdf37aee1d5bdc4a4582d1e98d9de9))
* 优化TaskManager批量数据库操作 - 添加batchUpdateStatus方法并在组任务完成时使用 ([1644421](https://github.com/YoungSx/drive-collector-js/commit/1644421264fb5b04a9c8293671e8c6fd8fb05d6e))
* 优化UI更新节流机制，基于任务状态和进度动态调整节流时间 ([f69aa58](https://github.com/YoungSx/drive-collector-js/commit/f69aa5857d40d738f4ed0f8288c956ce56c070d6))


### 🐛 Bug Fixes

* 修复测试语法错误，移除不兼容的await import语法 ([846aa3e](https://github.com/YoungSx/drive-collector-js/commit/846aa3e02a9a304c2d674c76a5d80b901d3602f1))
* 修复测试fake timers警告，条件性清理定时器 ([a759423](https://github.com/YoungSx/drive-collector-js/commit/a7594238b694fbfaf47e3360b098b85fcdf0672b))
* 修复所有npm test测试失败问题 ([29fbfce](https://github.com/YoungSx/drive-collector-js/commit/29fbfce5dfdb4cd2aff54e27e0fb6d8e29cff1d5))
* 修复最后的测试失败问题 ([d12845f](https://github.com/YoungSx/drive-collector-js/commit/d12845f28688889e5492a4c3e4229b7640adee36))
* 修复files.slice is not a function错误 ([2221578](https://github.com/YoungSx/drive-collector-js/commit/22215782358136b9bf24a652907ca72eaca87052))
* 修复npm test异步操作清理问题 ([aef32c2](https://github.com/YoungSx/drive-collector-js/commit/aef32c261d37effcc9080149563743e4bc6043d9))
* 重新创建TaskRepository缓存测试文件，修复语法错误 ([9e801d3](https://github.com/YoungSx/drive-collector-js/commit/9e801d3700a66b27530c2d83f29acbbe577afb32))
* **文件列表命令**：修复异步错误中的TypeError，确保文件列表功能正常工作，提升用户体验稳定性。

## [2.3.1] - 2025-12-24

### 🐛 Bug Fixes

* **连接稳定性**：修复Telegram连接超时和数据中心切换问题，大幅提升文件下载的成功率和系统稳定性。通过优化连接参数、重试机制和并发控制，解决了"Not connected"和"File lives in another DC"等常见连接错误。

## [2.3.0] - 2025-12-24

### ✨ Features

* **智能队列分离**：将文件下载和上传流程分离为独立队列，大幅提升系统并发处理能力。下载队列专注处理Telegram文件获取，上传队列专门管理云端转存，两者互不干扰，显著提高了整体处理效率和系统稳定性。

## [2.2.5] - 2025-12-24

### 🐛 Bug Fixes

* **Telegram 连接**: 修复应用启动时的 AUTH_KEY_DUPLICATED 错误，添加自动 Session 清理和重试机制，提升连接稳定性。

## [2.2.4] - 2025-12-24

### ✅ Testing

* **代码文档**: 完善了 TaskRepository 和 D1 服务类的文档注释，提升代码可读性。
* **测试优化**: 调整了相关单元测试用例，确保测试覆盖率的稳定性和准确性。

## [2.2.3] - 2025-12-24

### 🐛 Bug Fixes

* resolve D1 batch error and prevent data loss in flushUpdates ([82d119b](https://github.com/YoungSx/drive-collector-js/commit/82d119b52f6f136a5bcdc74bc2020e838a3510b0))
* sanitize user input and variables in messages to prevent HTML rendering issues ([d6df339](https://github.com/YoungSx/drive-collector-js/commit/d6df339be01c308a320deacc23b64354fcc3e841))

## [2.2.2] - 2025-12-24

### ✅ Testing

* **测试修复**: 修复了 Rclone 批量上传、Telegram 服务和 UI 助手的单元测试用例，解决了依赖冲突和 Mock 不正确的问题，确保 CI/CD 流程的稳定运行。

## [2.2.1] - 2025-12-24

### 🐛 Bug Fixes

* **状态显示**: 修复了在没有等待任务时，系统状态面板中“等待中的任务”数量错误显示为占位符的问题。

## [2.2.0] - 2025-12-24

### ✨ Features
* **欢迎消息**: 优化欢迎消息的排版格式，提升命令列表的可读性。

### 🔧 Maintenance
* **数据库**: 优化 D1 数据库批量操作的错误处理逻辑，提升数据操作的可靠性。

## [2.1.4] - 2025-12-24

### 🐛 Bug Fixes
* **文件列表服务**: 修复了 Rclone `lsjson` 在目录不存在时报错的问题，增强了路径检测的鲁棒性。
* **分发器逻辑**: 解决了 `Dispatcher` 中 `PRIORITY` 变量未定义的 ReferenceError，恢复了 `/files` 命令的正常响应。
* **单元测试**: 修复了 `TaskManager` 和 `CloudTool` 的多个单元测试用例，提高了测试套件的稳定性。

## [2.1.2] - 2025-12-24

### 🔧 Maintenance
* **发布流程革新**: 优化 AI 版本管理规则，实现版本号与 Commit 信息解耦。
* **自动化脚本升级**: 调整 `release-ai` 脚本，支持静默生成与 AI 驱动的总结性提交。

## [2.1.1] - 2025-12-24

### ✨ Features
* **新增帮助菜单**: 实现 `/help` 命令，提供详细的使用指南，并自动显示当前版本号。
* **分发逻辑优化**: 在 `Dispatcher` 中引入 `fs` 和 `path` 模块以支持版本读取。

## [2.1.0] - 2025-12-24

### ✨ Features
* **自动化发布流**: 引入基于 AI 驱动的自动化版本发布工作流，集成 `standard-version` 实现语义化版本管理。
* **限流策略优化**:
    * 引入分布式频率限制与任务优先级调度系统。
    * 实现自适应速率限制（Auto-scaling），动态调整 Telegram Bot API 与 MTProto 的并发数。
    * 增加 Auth 敏感流程的优先级感知限流。
* **多用户架构**:
    * 实现多用户架构及交互式云盘登录，增强租户隔离与安全性。
    * 支持任务持久化与 D1 数据库恢复，确保系统重启后的任务连续性。
* **文件管理增强**:
    * 实现统一的网盘管理与状态监控指令系统。
    * 优化网盘配置流程，支持 `/logout` 注销功能。
    * 引入内存级文件列表缓存，大幅提升分页浏览性能。
* **UI/UX 优化**:
    * 全面优化移动端 UI 布局，引入智能文件名缩写与简洁状态标签。
    * 实时显示上传进度，支持点击文件链接跳转至原始消息。

### 🚀 Performance
* **自适应缩放**: 自动监控 API 成功率并实时调整并发（Bot API: 20-30 QPS, MTProto: 3-8 并发）。
* **下载稳定性**: 将下载块大小提升至 1MB，增强大文件传输的稳定性。
* **缓存系统**: 在 Drive、Settings 和 Task 仓库中全面引入多级缓存机制。

### 🐛 Bug Fixes
* **隔离性修复**: 修复多租户隔离失效问题，通过连接字符串模式确保数据安全。
* **运行时错误**: 解决自适应限流中的 `ReferenceError` 和作用域绑定问题。
* **初始化优化**: 实现非阻塞式初始化，提升机器人启动响应速度。

### ✅ Testing
* **测试覆盖**: 构建完整的单元测试套件，涵盖核心模块、Rclone 服务及 Repository 模式，整体覆盖率显著提升。
* **CI/CD**: 引入自动化测试流水线，确保代码提交质量。

[3.0.1]: https://github.com/YoungSx/drive-collector-js/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/YoungSx/drive-collector-js/compare/v2.4.1...v3.0.0
[2.4.1]: https://github.com/YoungSx/drive-collector-js/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/YoungSx/drive-collector-js/compare/v2.3.6...v2.4.0
[2.3.6]: https://github.com/YoungSx/drive-collector-js/compare/v2.3.5...v2.3.6
[2.3.5]: https://github.com/YoungSx/drive-collector-js/compare/v2.3.4...v2.3.5