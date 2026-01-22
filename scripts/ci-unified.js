#!/usr/bin/env node

/**
 * 统一的CI脚本 - 增强版
 * 整合所有CI逻辑，包括环境检测、Docker构建、发布和通知
 * 目标：将 YAML 配置文件减少到最小，实现 "Infrastructure as Code" 的最大便携性
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import https from 'https';

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
    const isLocal = this.envVars.ACT_LOCAL === 'true' || !isGithub;
    
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
    try {
      // 继承stdio以显示进度
      execSync(command, { stdio: 'inherit', encoding: 'utf8' });
      console.log(`✅ ${description} 成功`);
      return true;
    } catch (error) {
      console.error(`❌ ${description} 失败`);
      throw error;
    }
  }

  login() {
    const { actor } = this.envManager.context;
    // 使用 GITHUB_TOKEN 或 CR_PAT (Container Registry Personal Access Token)
    const token = process.env.GITHUB_TOKEN || process.env.CR_PAT;

    if (!token) {
      if (this.envManager.context.isLocal) {
        console.log('ℹ️ 本地模式跳过自动登录，假设用户已登录');
        return;
      }
      throw new Error('缺少 Docker 登录 Token (GITHUB_TOKEN 或 CR_PAT)');
    }

    // 安全起见，不打印token
    // 管道传递密码给docker login
    try {
        execSync(`echo "${token}" | docker login ${this.registry} -u ${actor} --password-stdin`, { stdio: 'pipe' });
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

  async buildAndPush(targetEnv) {
    const { repository } = this.envManager.context;
    if (!repository) {
        throw new Error('无法确定镜像仓库名称 (缺少 GITHUB_REPOSITORY)');
    }

    const imageName = `${this.registry}/${repository.toLowerCase()}`;
    const tags = this.generateTags(imageName);
    
    console.log(`🏷️ 生成的 Tags: \n${tags.map(t => `  - ${t}`).join('\n')}`);

    const tagArgs = tags.map(t => `-t ${t}`).join(' ');
    
    // 构建参数
    const buildArgs = `--build-arg NODE_ENV=${targetEnv.id}`;
    
    // 缓存策略: 尝试从 registry 拉取缓存
    // 本地使用本地缓存，CI尝试使用 --cache-from
    let cacheArgs = '';
    if (!this.envManager.context.isLocal) {
        cacheArgs = `--cache-from type=registry,ref=${imageName}:latest --cache-to type=inline`;
    }

    // 构建命令
    const buildCmd = `docker build . ${buildArgs} ${tagArgs} ${cacheArgs}`;
    this.execute(buildCmd, '构建镜像');

    // 推送逻辑
    if (this.envManager.context.isLocal) {
        console.log('ℹ️ 本地模式：跳过推送 (Push)');
    } else {
        tags.forEach(tag => {
            this.execute(`docker push ${tag}`, `推送镜像 ${tag}`);
        });
    }
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

  async runFullPipeline() {
    console.log(`🚀 启动流水线 | 环境: ${this.targetEnv.name} (${this.targetEnv.id}) | 模式: ${this.envManager.context.isLocal ? 'Local' : 'CI'}`);
    
    let success = true;

    try {
        // 1. Validate
        this.executeStep('Manifest Validation', 'node scripts/ci-unified.js validate');

        // 2. Install
        const installCmd = this.envManager.context.isLocal ? 'npm install' : 'npm ci';
        this.executeStep('Install Dependencies', installCmd);

        // 3. Lint
        // 检查是否有 lint 脚本
        const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
        if (pkg.scripts && pkg.scripts.lint) {
            this.executeStep('Linting', 'npm run lint');
        }

        // 4. Test
        this.executeStep('Tests', 'npm run test:coverage');

        // 5. Docker Build & Publish (仅在 push 到主分支或 Tag 时，或者强制开启)
        // 简单的逻辑：CI环境且是非PR触发
        const shouldBuildDocker = process.env.CI_BUILD_DOCKER === 'true' || 
            (
                !this.envManager.context.isLocal && 
                this.envManager.context.eventName !== 'pull_request'
            );

        if (shouldBuildDocker) {
            console.log('\n🔹 [Step] Docker Pipeline...');
            const dockerStart = Date.now();
            this.dockerManager.login();
            await this.dockerManager.buildAndPush(this.targetEnv);
            this.recordMetric('Docker', (Date.now() - dockerStart) / 1000);
        } else {
            console.log('\nℹ️ 跳过 Docker 构建 (条件不满足)');
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
}

// Entry Point
const script = new UnifiedCIScript();
const args = process.argv.slice(2);
const command = args[0];

if (command === 'validate') {
    script.validateManifest();
} else if (command === 'pipeline' || command === 'full') {
    script.runFullPipeline();
} else {
    // 默认行为或帮助
    console.log(`
Usage: node scripts/ci-unified.js [command]

Commands:
  pipeline    运行完整流水线 (Install -> Lint -> Test -> Docker -> Notify)
  validate    仅运行元数据验证
`);
    // 如果没有参数，也什么都不做，防止报错，但在 CI 中通常会明确调用
    if (!command) process.exit(1);
}
