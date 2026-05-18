#!/usr/bin/env node

/**
 * 统一的CI脚本 - 增强版
 * 整合所有CI逻辑，包括环境检测、Docker构建、发布和通知
 * 目标：将 YAML 配置文件减少到最小，实现 "Infrastructure as Code" 的最大便携性
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import https from 'https';
import crypto from 'crypto';
import { getBuildReleaseId } from '../src/utils/buildIdentity.js';

const VALID_COMMANDS = new Set(['full', 'pipeline', 'validate', 'sync', 'quick', 'lint', 'test', 'build']);

const MODE_PLANS = {
  full: ['validate', 'install', 'lint', 'test', 'docker'],
  'lint-only': ['validate', 'install', 'lint'],
  'test-only': ['validate', 'install', 'test'],
  'build-only': ['validate', 'install', 'docker'],
  sync: ['validate', 'static'],
  quick: ['validate', 'static']
};

function normalizeCommand(command = 'full') {
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`未知 CI 命令: ${command}`);
  }
  return command === 'pipeline' ? 'full' : command;
}

function resolveCiMode(command, env = process.env) {
  const normalizedCommand = normalizeCommand(command);
  const commandModeMap = {
    full: env.CI_MODE || 'full',
    lint: 'lint-only',
    test: 'test-only',
    build: 'build-only',
    sync: 'sync',
    quick: 'quick',
    validate: 'validate'
  };

  const mode = commandModeMap[normalizedCommand];
  if (!mode) {
    throw new Error(`无法解析 CI 命令: ${command}`);
  }
  if (mode !== 'validate' && !MODE_PLANS[mode]) {
    throw new Error(`未知 CI_MODE: ${mode}`);
  }
  return mode;
}

function getCiPlan(command, env = process.env) {
  const mode = resolveCiMode(command, env);
  return mode === 'validate' ? ['validate'] : MODE_PLANS[mode];
}

function buildDockerIdentityArgs({ nodeEnv, version, sha, shortSha, imageTag, buildTime = new Date().toISOString() }) {
  const releaseId = getBuildReleaseId(version, sha || shortSha);
  return [
    `NODE_ENV=${nodeEnv}`,
    `APP_VERSION=${version}`,
    `GIT_SHA=${sha || 'unknown'}`,
    `BUILD_TIME=${buildTime}`,
    `IMAGE_TAG=${imageTag || 'unknown'}`,
    `RELEASE_ID=${releaseId}`
  ];
}

/**
 * GitHub App 认证管理器
 * 负责生成 JWT 并获取 Installation Access Token
 */
class GitHubAppAuth {
  constructor(appId, privateKey) {
    this.appId = appId;
    this.privateKey = privateKey;
  }

  generateJWT() {
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60,
      exp: now + (10 * 60),
      iss: this.appId
    };

    const base64Url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const data = `${base64Url(header)}.${base64Url(payload)}`;
    
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(data);
    const signature = sign.sign(this.privateKey, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    return `${data}.${signature}`;
  }

  async getInstallationToken(repository) {
    const jwt = this.generateJWT();
    
    // 1. Get Installation ID for the repo
    // GET /repos/{owner}/{repo}/installation
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) throw new Error(`无效的仓库名称: ${repository}`);

    const installation = await this.request(`https://api.github.com/repos/${owner}/${repo}/installation`, jwt);
    console.log(`   Installation ID: ${installation.id}`);
    
    // 2. Get Access Token
    // POST /app/installations/{installation_id}/access_tokens
    const tokenData = await this.request(`https://api.github.com/app/installations/${installation.id}/access_tokens`, jwt, 'POST');
    
    if (tokenData.permissions) {
        console.log(`   Token Permissions: ${JSON.stringify(tokenData.permissions)}`);
    }
    
    return tokenData.token;
  }

  request(url, jwt, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method,
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'User-Agent': 'Node.js CI Script',
          'Accept': 'application/vnd.github.v3+json'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
                resolve(JSON.parse(data));
            } catch (e) {
                reject(new Error(`JSON Parse Error: ${e.message}`));
            }
          } else {
            reject(new Error(`GitHub API Error: ${res.statusCode} ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
}

/**
 * 环境管理器
 * 负责识别当前CI环境、Git上下文
 */
class EnvironmentManager {
  constructor() {
    this.envVars = process.env;
    this.context = this.detectContext();
  }

  detectContext() {
    const isGithub = this.envVars.GITHUB_ACTIONS === 'true';
    // ACT=true 是 act 工具自动注入的环境变量
    const isLocal = this.envVars.ACT_LOCAL === 'true' || this.envVars.ACT === 'true' || !isGithub;
    
    // 获取Git引用信息
    let ref = this.envVars.GITHUB_REF || '';
    let sha = this.envVars.GITHUB_SHA || '';
    let actor = this.envVars.GITHUB_ACTOR || '';
    let repository = this.envVars.GITHUB_REPOSITORY || '';

    // 尝试从 eventpath 获取 ref (act 常用)
    if (this.envVars.GITHUB_EVENT_PATH && existsSync(this.envVars.GITHUB_EVENT_PATH)) {
        try {
            const event = JSON.parse(readFileSync(this.envVars.GITHUB_EVENT_PATH, 'utf8'));
            if (!ref && event.ref) ref = event.ref;
            if (!sha && event.after) sha = event.after;
            if (!repository && event.repository?.full_name) repository = event.repository.full_name;
        } catch (e) {}
    }

    // 本地开发回退策略
    if (isLocal && !ref) {
      try {
        ref = execSync('git symbolic-ref -q HEAD || git describe --all --exact-match', { encoding: 'utf8' }).trim();
        sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
        // 尝试从package.json获取repo信息作为默认
        try {
            const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
            if (pkg.repository && pkg.repository.url) {
                const match = pkg.repository.url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
                if (match) repository = match[1];
            }
        } catch (e) {}
      } catch (e) {
        console.warn('⚠️ 无法获取本地Git信息');
      }
    }

    return {
      isGithub,
      isLocal,
      ref,
      sha,
      shortSha: sha.substring(0, 7),
      actor,
      repository,
      eventName: this.envVars.GITHUB_EVENT_NAME || 'manual'
    };
  }

  determineTargetEnvironment() {
    const { ref } = this.context;
    
    if (ref === 'refs/heads/main' || ref === 'main') {
      return { 
        id: 'prod', 
        name: '生产环境', 
        infisicalEnv: 'prod' 
      };
    } else if (ref === 'refs/heads/develop' || ref === 'develop') {
      return { 
        id: 'pre', 
        name: '预发布环境', 
        infisicalEnv: 'pre' 
      };
    } else {
      return { 
        id: 'dev', 
        name: '开发环境', 
        infisicalEnv: 'dev' 
      };
    }
  }

  getVersion() {
    try {
      const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
      return packageJson.version;
    } catch (e) {
      return '0.0.0';
    }
  }
}

/**
 * Docker管理器
 * 负责Docker登录、构建、标记和推送
 */
class DockerManager {
  constructor(envManager) {
    this.envManager = envManager;
    this.registry = 'ghcr.io';
  }

  execute(command, description) {
    console.log(`🐳 Docker: ${description}...`);
    console.log(`[DEBUG] command: "${command}"`);
    console.log(`[DEBUG] command.length: ${command.length}`);
    const [cmd, ...args] = command.split(' ');
    console.log(`[DEBUG] cmd: "${cmd}"`);
    console.log(`[DEBUG] args:`, args);
    console.log(`[DEBUG] args.length: ${args.length}`);
    try {
      // 使用 spawnSync 替代 execSync
      const result = spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8', shell: true });
      
      if (result.status !== 0) {
          throw new Error(`Command failed with status ${result.status}`);
      }
      console.log(`✅ ${description} 成功`);
      return true;
    } catch (error) {
      console.error(`❌ ${description} 失败`);
      console.error(`[DEBUG] error:`, error);
      throw error;
    }
  }

  buildSmoke(targetEnv) {
    const tag = `drive-collector-bot:ci-${targetEnv.id}`;
    const { sha, shortSha } = this.envManager.context;
    const version = this.envManager.getVersion();
    const buildTime = new Date().toISOString();
    const identityBuildArgs = buildDockerIdentityArgs({
      nodeEnv: targetEnv.id,
      version,
      sha,
      shortSha,
      imageTag: tag,
      buildTime
    });
    const buildArgs = [
      'build',
      '.',
      '--file',
      'Dockerfile',
      ...identityBuildArgs.flatMap(arg => ['--build-arg', arg]),
      '--tag',
      tag
    ];

    if (process.env.CI_DOCKER_PLATFORM) {
      buildArgs.splice(4, 0, '--platform', process.env.CI_DOCKER_PLATFORM);
    }

    console.log(`🐳 Docker: 构建镜像 smoke test (${tag})...`);
    const result = spawnSync('docker', buildArgs, { stdio: 'inherit', encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`Docker smoke build failed with status ${result.status}`);
    }
    console.log('✅ Docker smoke build 成功');
  }

  async login() {
    const { actor, repository } = this.envManager.context;
    // 使用 GITHUB_TOKEN 或 CR_PAT (Container Registry Personal Access Token)
    let token = process.env.GITHUB_TOKEN || process.env.CR_PAT;
    let isAppToken = false;

    // 尝试使用 GitHub App 认证
    if (!token && process.env.APP_ID && process.env.APP_PRIVATE_KEY) {
        try {
            console.log(`ℹ️ 检测到 GitHub App 凭证，尝试获取 Installation Token (Repo: ${repository})...`);
            // 处理私钥格式 (替换 \n 为换行符)
            const privateKey = process.env.APP_PRIVATE_KEY.replace(/\\n/g, '\n');
            const appAuth = new GitHubAppAuth(process.env.APP_ID, privateKey);
            token = await appAuth.getInstallationToken(repository);
            isAppToken = true;
            console.log(`✅ GitHub App Token 获取成功 (Prefix: ${token.substring(0, 4)}...)`);
        } catch (e) {
            console.error(`❌ GitHub App 认证失败: ${e.message}`);
            // 不抛出错误，继续后续逻辑（可能会跳过登录）
        }
    }

    if (!token) {
      if (this.envManager.context.isLocal) {
        console.log('ℹ️ 本地模式跳过自动登录，假设用户已登录');
        return;
      }
      throw new Error('缺少 Docker 登录 Token (GITHUB_TOKEN 或 CR_PAT)');
    }

    // 安全起见，不打印token
    // 管道传递密码给docker login
    // 如果是 App Token，使用 x-access-token 作为用户名
    const username = isAppToken ? 'x-access-token' : actor;

    try {
        console.log(`   Logging in as ${username}...`);
        // 使用 spawnSync 避免 echo 可能带来的 shell 注入或截断问题
        const loginResult = spawnSync('docker', ['login', this.registry, '-u', username, '--password-stdin'], {
            input: token,
            stdio: ['pipe', 'inherit', 'inherit']
        });
        
        if (loginResult.status !== 0) {
            throw new Error(`Docker login failed with status ${loginResult.status}`);
        }
        console.log('✅ Docker Registry 登录成功');
    } catch (e) {
        console.error('❌ Docker Registry 登录失败');
        throw e;
    }
  }

  generateTags(imageName) {
    const { ref, sha, shortSha } = this.envManager.context;
    const version = this.envManager.getVersion();
    const tags = [];

    // 基础: latest (仅main分支), sha
    tags.push(`${imageName}:sha-${shortSha}`);
    
    // 分支名 Tag (替换非法字符)
    const branchName = ref.replace('refs/heads/', '').replace(/[^a-zA-Z0-9.-]/g, '-');
    if (branchName) {
        tags.push(`${imageName}:${branchName}`);
    }

    // SemVer Tag (仅当是 tag 推送或 main 分支)
    if (ref === 'refs/heads/main' || ref.startsWith('refs/tags/')) {
        tags.push(`${imageName}:${version}`);
        tags.push(`${imageName}:latest`);
    }

    return [...new Set(tags)]; // 去重
  }

  getBuildPlatforms() {
    const configuredPlatforms = process.env.CI_DOCKER_PLATFORM || process.env.DOCKER_BUILD_PLATFORMS;
    if (!configuredPlatforms) return '';

    return configuredPlatforms
      .split(',')
      .map(platform => platform.trim())
      .filter(Boolean)
      .join(',');
  }

  async buildAndPush(targetEnv) {
    const { repository, sha, shortSha } = this.envManager.context;
    if (!repository) {
        throw new Error('无法确定镜像仓库名称 (缺少 GITHUB_REPOSITORY)');
    }

    const imageName = `${this.registry}/${repository.toLowerCase()}`;
    const tags = this.generateTags(imageName);
    const version = this.envManager.getVersion();
    const buildTime = new Date().toISOString();
    const canonicalImageTag = tags.find(tag => tag.includes(`:sha-${shortSha}`)) || tags[0] || 'unknown';
    const identityBuildArgs = buildDockerIdentityArgs({
        nodeEnv: targetEnv.id,
        version,
        sha,
        shortSha,
        imageTag: canonicalImageTag,
        buildTime
    });
    
    console.log(`🏷️ 生成的 Tags: \n${tags.map(t => `  - ${t}`).join('\n')}`);

    const tagArgs = tags.map(t => `-t ${t}`).join(' ');
    
    // 构建参数
    const buildArgs = identityBuildArgs.map(arg => `--build-arg ${arg}`).join(' ');
    const platformArg = this.getBuildPlatforms();
    
    // 缓存策略: 尝试从 registry 拉取缓存
    // 本地使用本地缓存，CI尝试使用 --cache-from
    let cacheArgs = '';
    if (!this.envManager.context.isLocal) {
        cacheArgs = `--cache-from type=registry,ref=${imageName}:latest --cache-to type=inline`;
    }

    const outputArg = this.envManager.context.isLocal ? '--load' : '--push';
    const platformArgs = platformArg ? `--platform ${platformArg}` : '';

    // 构建命令 - CI 使用 buildx --push 生成/推送多架构 manifest；本地仍 --load 方便 smoke。
    const buildCmd = `docker buildx build . ${outputArg} ${platformArgs} ${buildArgs} ${tagArgs} ${cacheArgs}`;
    console.log(`[DEBUG] buildCmd: "${buildCmd}"`);
    console.log(`[DEBUG] buildCmd.split(' '):`, buildCmd.split(' '));
    this.execute(buildCmd, '构建镜像');

    if (this.envManager.context.isLocal) {
        console.log('ℹ️ 本地模式：镜像已加载到本地 Docker，跳过推送');
        return;
    }

    console.log('✅ Docker buildx 已完成镜像推送');
  }
}

/**
 * 通知管理器
 * 负责发送构建结果通知 (Bark 等)
 */
class NotificationManager {
  constructor(envManager) {
    this.envManager = envManager;
    this.webhookUrl = process.env.BARK_WEBHOOK_URL;
    this.deviceToken = process.env.BARK_DEVICE_TOKEN;
  }

  async send(status, targetEnv, workflowName) {
    if (!this.webhookUrl || !this.deviceToken) {
      console.log('ℹ️ 未配置通知密钥 (BARK_WEBHOOK_URL/BARK_DEVICE_TOKEN)，跳过通知');
      return;
    }

    const { sha, ref } = this.envManager.context;
    const isSuccess = status === 'success';
    
    const title = `${isSuccess ? '✅' : '❌'} CI/CD ${isSuccess ? '成功' : '失败'} [${targetEnv.name}]`;
    const content = `环境: ${targetEnv.name}\nWorkflow: ${workflowName}\nStatus: ${status}\nRef: ${ref}\nCommit: ${sha.substring(0, 7)}`;
    
    const payload = {
        title,
        body: content,
        device_key: this.deviceToken,
        group: 'GHA',
        icon: isSuccess ? 'https://github.githubassets.com/images/icons/emoji/unicode/2705.png' : 'https://github.githubassets.com/images/icons/emoji/unicode/274c.png'
    };

    // 规范化 URL
    const baseUrl = this.webhookUrl.endsWith('/') ? this.webhookUrl : `${this.webhookUrl}/`;

    return new Promise((resolve) => {
        console.log('📨 发送通知...');
        const req = https.request(`${baseUrl}push`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            }
        }, (res) => {
            console.log(`📨 通知响应: ${res.statusCode}`);
            resolve();
        });

        req.on('error', (e) => {
            console.error(`❌ 通知发送失败: ${e.message}`);
            resolve(); // 不阻塞流程
        });

        req.write(JSON.stringify(payload));
        req.end();
    });
  }
}

/**
 * 统一 CI 脚本主类
 */
class UnifiedCIScript {
  constructor() {
    this.envManager = new EnvironmentManager();
    this.dockerManager = new DockerManager(this.envManager);
    this.notificationManager = new NotificationManager(this.envManager);
    
    this.targetEnv = this.envManager.determineTargetEnvironment();
    this.workflowName = process.env.GITHUB_WORKFLOW || 'Unified CI';
    
    this.metrics = {
        startTime: Date.now(),
        steps: {}
    };
  }

  recordMetric(step, duration) {
    this.metrics.steps[step] = duration;
  }

  executeStep(name, command) {
    console.log(`\n🔹 [Step] ${name}...`);
    const start = Date.now();
    try {
        execSync(command, { stdio: 'inherit', encoding: 'utf8' });
        const duration = (Date.now() - start) / 1000;
        this.recordMetric(name, duration);
        console.log(`✅ ${name} 完成 (${duration}s)`);
        return true;
    } catch (e) {
        console.error(`❌ ${name} 失败`);
        throw e;
    }
  }

  shouldRun(plan, step) {
    return plan.includes(step);
  }

  installDependencies() {
    this.executeStep('Install Dependencies', 'npm ci');
  }

  runStaticQualityChecks() {
    this.executeStep('Manifest Duplicate Check', 'npm run check:manifest:duplicates');
    this.executeStep('Environment Manifest Check', 'npm run check:env');
    this.executeStep('JavaScript Syntax Check', "git ls-files '*.js' ':!:coverage/**' ':!:node_modules/**' | xargs -n 1 node --check");
  }

  runLintChecks() {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    if (pkg.scripts && pkg.scripts.lint) {
      this.executeStep('Linting', 'npm run lint');
      return;
    }
    this.runStaticQualityChecks();
  }

  runTests() {
    this.executeStep('Tests with Coverage Gate', 'npm run test:coverage');
  }

  async runDockerBuildGate({ publish = false } = {}) {
    console.log('\n🔹 [Step] Docker Build Gate...');
    const dockerStart = Date.now();

    if (publish) {
      await this.dockerManager.login();
      await this.dockerManager.buildAndPush(this.targetEnv);
    } else {
      this.dockerManager.buildSmoke(this.targetEnv);
    }

    this.recordMetric('Docker', (Date.now() - dockerStart) / 1000);
  }

  shouldPublishDocker() {
    return process.env.CI_DOCKER_PUSH === 'true' ||
      (
        !this.envManager.context.isLocal &&
        this.envManager.context.eventName !== 'pull_request' &&
        (this.envManager.context.ref === 'refs/heads/main' || this.envManager.context.ref.startsWith('refs/tags/'))
      );
  }

  async runFullPipeline() {
    console.log(`🚀 启动流水线 | 环境: ${this.targetEnv.name} (${this.targetEnv.id}) | 模式: ${this.envManager.context.isLocal ? 'Local' : 'CI'}`);
    const command = process.env.CI_COMMAND || 'full';
    const plan = getCiPlan(command, process.env);
    console.log(`📋 执行计划: ${plan.join(' -> ')}`);

    let success = true;

    try {
        if (this.shouldRun(plan, 'validate')) {
          this.executeStep('Manifest Validation', 'node scripts/ci-unified.js validate');
        }

        if (this.shouldRun(plan, 'install')) {
          this.installDependencies();
        }

        if (this.shouldRun(plan, 'static')) {
          this.runStaticQualityChecks();
        }

        if (this.shouldRun(plan, 'lint')) {
          this.runLintChecks();
        }

        if (this.shouldRun(plan, 'test')) {
          this.runTests();
        }

        if (this.shouldRun(plan, 'docker')) {
          await this.runDockerBuildGate({ publish: command === 'full' && this.shouldPublishDocker() });
        }

    } catch (error) {
        success = false;
        console.error('\n💥 流水线异常中断');
        console.error(error.message);
    } finally {
        // 6. Report & Notify
        const totalDuration = (Date.now() - this.metrics.startTime) / 1000;
        console.log(`\n📊 总耗时: ${totalDuration}s`);
        console.table(this.metrics.steps);

        await this.notificationManager.send(success ? 'success' : 'failure', this.targetEnv, this.workflowName);
        
        process.exit(success ? 0 : 1);
    }
  }

  // 兼容旧的 validate 调用
  validateManifest() {
    try {
        if (!existsSync('manifest.json')) throw new Error('manifest.json 缺失');
        const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
        const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
        if (manifest.version !== pkg.version) throw new Error('版本不匹配');
        console.log(`✅ Manifest 验证通过 (v${pkg.version})`);
    } catch (e) {
        console.error(`❌ Manifest 验证失败: ${e.message}`);
        process.exit(1);
    }
  }

  async runCommand(command) {
    const normalizedCommand = normalizeCommand(command);

    if (normalizedCommand === 'validate') {
      this.validateManifest();
      return;
    }

    process.env.CI_COMMAND = normalizedCommand;
    await this.runFullPipeline();
  }
}

// Entry Point
if (import.meta.url === `file://${process.argv[1]}`) {
  const script = new UnifiedCIScript();
  const args = process.argv.slice(2);
  const command = args[0] || 'full';

  script.runCommand(command).catch((error) => {
    console.error(`❌ ${error.message}`);
    console.log(`
Usage: node scripts/ci-unified.js [command]

Commands:
  full        运行完整流水线
  lint        运行静态质量门禁
  test        运行测试和覆盖率门禁
  build       运行 Docker build smoke
  sync        运行 manifest 同步前置门禁
  quick       运行快速静态门禁
  validate    仅运行 manifest 版本验证
`);
    process.exit(1);
  });
}

export { buildDockerIdentityArgs, getCiPlan, normalizeCommand, resolveCiMode };
