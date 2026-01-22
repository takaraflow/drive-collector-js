#!/usr/bin/env node

/**
 * CI/CD Runner - Unified & Platform-Agnostic
 *
 * Capability:
 * - Detects execution context (GitHub Actions vs Local vs Other)
 * - Parses `cicd/config.yaml` with zero external dependencies
 * - Resolves environment (prod/pre/dev) based on git branch/tag
 * - Executes configured checks/steps with conditional logic
 * - Generates Docker build flags based on environment policies
 * - Sends notifications via Bark/Slack
 */

import fs from 'fs';
import path from 'path';
import { spawnSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'cicd', 'config.yaml');

// ==========================================
// 1. Robust Simple YAML Parser (Zero Dep)
// ==========================================
function parseYamlValue(val) {
  val = val.trim();
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null') return null;
  if (!isNaN(val) && val !== '') return Number(val);
  
  // Remove quotes if present
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  
  // Array handling: [a, b, c]
  if (val.startsWith('[') && val.endsWith(']')) {
    return val.slice(1, -1).split(',').map(v => parseYamlValue(v.trim()));
  }
  
  return val;
}

function simpleYamlParse(content) {
  const result = {};
  const lines = content.split('\n');
  const stack = [{ indent: -1, obj: result }];
  
  for (let line of lines) {
    // Strip comments
    const commentIndex = line.indexOf('#');
    if (commentIndex !== -1) line = line.substring(0, commentIndex);
    
    if (!line.trim()) continue;
    
    const indent = line.search(/\S/);
    const trimmed = line.trim();
    
    // Find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;
    
    // Key-Value pair
    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      let [_, key, value] = match;
      key = key.trim();
      value = value.trim();
      
      if (!value) {
        // It's a new object (nested)
        parent[key] = {};
        stack.push({ indent, obj: parent[key] });
      } else {
        // Handle array values like ["val1", "val2"]
        if (value.startsWith('[') && value.endsWith(']')) {
          parent[key] = value.slice(1, -1).split(',').map(v => parseYamlValue(v.trim()));
        } else if (value.startsWith('-')) {
            // It's a list item, but our simple parser might struggle with multi-line lists unless we handle indent
            // For now, assume simplified format or fix manually if needed.
            // Actually, standard YAML list items start on new lines. 
            // This parser is very basic. Use 'yaml' package if possible.
            parent[key] = parseYamlValue(value);
        } else {
          // It's a leaf value
          parent[key] = parseYamlValue(value);
        }
      }
    } else if (trimmed.startsWith('- ')) {
        // List item handling for previous key
        // This simple parser assumes the previous key was initialized as array if we see dashes
        // But we initialized it as object {}. This is a limitation.
        // For robustness, users should use ["a", "b"] syntax for simple lists in zero-dep mode.
        // Or we rely on 'yaml' package being installed usually.
    }
  }
  return result;
}

// ==========================================
// 2. Utils
// ==========================================
function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

function interpolate(str, context) {
  if (typeof str !== 'string') return str;
  
  return str.replace(/\$\{\{\s*([\w\.]+)\s*\}\}/g, (match, path) => {
    let value = getNestedValue(context, path);
    
    // Fallback to Env vars if not found in context object
    if (value === undefined || value === null) {
        // Try to match secrets.* or plain env vars
        const envKey = path.replace('secrets.', '').replace('env.', '');
        value = process.env[envKey];
    }
    
    return value !== undefined ? value : '';
  });
}

function runCommand(command, cwd = ROOT_DIR, env = {}) {
  console.log(`> ${command}`);
  const result = spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    stdio: 'inherit'
  });
  
  if (result.status !== 0) {
    throw new Error(`Command failed with code ${result.status}: ${command}`);
  }
}

// ==========================================
// 2.1 Notification Helper
// ==========================================
async function sendNotification(config, context, status, message) {
  const notifications = config.notifications || {};
  const isSuccess = status === 'success';
  const icon = isSuccess ? '✅' : '❌';
  const title = `${icon} CI ${isSuccess ? 'Success' : 'Failed'}: ${context.env}`;
  const body = `${message}\nRepo: ${context.github_repository}\nBranch: ${context.branch}\nCommit: ${context.sha.substring(0, 7)}`;

  // 1. Bark Notification
  if (notifications.bark && notifications.bark.enabled) {
    let webhookUrl = notifications.bark.webhook_webhook_url || process.env.BARK_WEBHOOK_URL;
    let deviceToken = notifications.bark.device_token || process.env.BARK_DEVICE_TOKEN;
    
    // Interpolate if it contains placeholders
    if (notifications.bark.webhook_url) {
        webhookUrl = interpolate(notifications.bark.webhook_url, context);
    }
    if (notifications.bark.device_token) {
        deviceToken = interpolate(notifications.bark.device_token, context);
    }

    // Construct URL if token is separated
    let finalUrl = webhookUrl;
    if (!finalUrl && deviceToken) {
        finalUrl = `https://api.day.app/${deviceToken}`;
    }

    if (finalUrl) {
        try {
            // Clean up URL
            if (finalUrl.endsWith('/')) finalUrl = finalUrl.slice(0, -1);
            
            const group = notifications.bark.group || 'CI';
            const url = `${finalUrl}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${group}&icon=${isSuccess ? 'https://github.githubassets.com/images/icons/emoji/unicode/2705.png' : 'https://github.githubassets.com/images/icons/emoji/unicode/274c.png'}`;
            
            console.log(`   [Notification] Sending Bark notification...`);
            spawnSync('curl', ['-s', '-L', '-X', 'GET', url], { stdio: 'ignore' });
        } catch (e) {
            console.warn(`   [Notification] Failed to send Bark notification: ${e.message}`);
        }
    } else {
        console.warn('   [Notification] Bark enabled but no URL/Token found.');
    }
  }

  // 2. Slack Notification
  if (notifications.slack && notifications.slack.enabled) {
      let webhookUrl = notifications.slack.webhook_url || process.env.SLACK_WEBHOOK_URL;
      webhookUrl = interpolate(webhookUrl, context);
      
      if (webhookUrl) {
          try {
              console.log(`   [Notification] Sending Slack notification...`);
              const payload = JSON.stringify({
                  text: `*${title}*\n${body}`
              });
              spawnSync('curl', ['-s', '-X', 'POST', '-H', 'Content-type: application/json', '--data', payload, webhookUrl], { stdio: 'ignore' });
          } catch(e) {
              console.warn(`   [Notification] Failed to send Slack notification: ${e.message}`);
          }
      }
  }
}

// ==========================================
// 2.2 Docker Tag Resolver
// ==========================================
function resolveDockerTags(envConfig, context) {
    if (!envConfig || !envConfig.docker || !envConfig.docker.tags) return [];
    
    let tags = envConfig.docker.tags;
    
    // Handle simple parser limitations (might return obj instead of array)
    if (!Array.isArray(tags)) {
        if (typeof tags === 'object') {
             tags = Object.values(tags);
        } else {
            return [];
        }
    }
    
    const resolvedTags = [];
    const repo = interpolate(envConfig.docker.repository, context);
    const registry = envConfig.docker.registry;
    const fullImageName = `${registry}/${repo}`;

    for (const tagTmpl of tags) {
        if (typeof tagTmpl !== 'string') continue;
        
        let tagVal = '';
        if (tagTmpl.includes('type=ref,event=branch')) {
            if (!context.isTag) tagVal = context.branch.replace(/[^a-zA-Z0-9._-]/g, '-');
        } else if (tagTmpl.includes('type=sha')) {
            tagVal = `sha-${context.sha.substring(0, 7)}`;
        } else if (tagTmpl.includes('type=semver')) {
            if (context.isTag) {
                // Extracts v1.0.0 -> 1.0.0
                const version = context.branch.replace(/^v/, '');
                tagVal = version;
            }
        } else {
            tagVal = interpolate(tagTmpl, context);
        }

        if (tagVal) {
            resolvedTags.push(`${fullImageName}:${tagVal}`);
            // Also push 'latest' if on main branch and env is prod
            if (context.branch === 'main' && context.env === 'prod' && tagTmpl.includes('type=ref,event=branch')) {
                resolvedTags.push(`${fullImageName}:latest`);
            }
        }
    }
    
    return [...new Set(resolvedTags)]; // Unique
}

// ==========================================
// 2.3 Docker Build Execution
// ==========================================
function runDockerBuild(config, context) {
    if (!config.environments || !config.environments[context.env]) {
        console.log(`   [Docker] No environment config found for ${context.env}, skipping build.`);
        return;
    }

    const envConfig = config.environments[context.env];
    const dockerConfig = config.docker || {};
    
    // 1. Resolve Tags
    const tags = resolveDockerTags(envConfig, context);
    if (tags.length === 0) {
        console.log(`   [Docker] No tags resolved, skipping build.`);
        return;
    }

    console.log(`\n[DOCKER] Building for ${context.env}`);
    console.log(`   Tags: ${tags.join(', ')}`);

    // 2. Login (if credentials exist)
    const username = interpolate(dockerConfig.login?.username || '', context);
    const password = interpolate(dockerConfig.login?.password || '', context);
    const registry = dockerConfig.login?.registry || 'ghcr.io';

    if (username && password) {
        console.log(`   [Docker] Logging into ${registry}...`);
        // Mask password in logs
        try {
            // Using spawnSync with input to avoid password in process list
            const login = spawnSync('docker', ['login', registry, '-u', username, '--password-stdin'], {
                input: password,
                stdio: ['pipe', 'inherit', 'inherit']
            });
            if (login.status !== 0) throw new Error('Docker login failed');
        } catch (e) {
            console.error(`   [Docker] Login failed: ${e.message}`);
            // Don't exit, might allow local build
        }
    }

    // 3. Construct Build Command
    const buildConfig = dockerConfig.build || {};
    const contextPath = buildConfig.context || '.';
    const dockerfile = buildConfig.dockerfile || 'Dockerfile';
    
    let args = [
        'buildx', 'build',
        contextPath,
        '-f', dockerfile,
        '--push' // Default to push if in CI/Run mode
    ];

    // Tags
    tags.forEach(t => {
        args.push('-t', t);
    });

    // Build Args
    if (buildConfig.build_args) {
        const buildArgList = Array.isArray(buildConfig.build_args) ? buildConfig.build_args : Object.values(buildConfig.build_args);
        buildArgList.forEach(arg => {
            if (typeof arg === 'string') {
                // If defined as "KEY", try to get value from env
                const val = process.env[arg];
                if (val) {
                    args.push('--build-arg', `${arg}=${val}`);
                } else if (arg.includes('=')) {
                    // Defined as "KEY=VALUE"
                    args.push('--build-arg', interpolate(arg, context));
                }
            }
        });
    }

    // Cache
    if (buildConfig.cache_from) {
        const cacheFrom = Array.isArray(buildConfig.cache_from) ? buildConfig.cache_from : [buildConfig.cache_from];
        cacheFrom.forEach(c => {
            args.push('--cache-from', interpolate(c, context));
        });
    }
    if (buildConfig.cache_to) {
        const cacheTo = Array.isArray(buildConfig.cache_to) ? buildConfig.cache_to : [buildConfig.cache_to];
        cacheTo.forEach(c => {
            args.push('--cache-to', interpolate(c, context));
        });
    }

    // Platforms
    if (buildConfig.platforms) {
        const platforms = Array.isArray(buildConfig.platforms) ? buildConfig.platforms : [buildConfig.platforms];
        args.push('--platform', platforms.join(','));
    }

    // Run Build
    try {
        console.log(`   [Docker] Executing build...`);
        // console.log(`   Command: docker ${args.join(' ')}`); 
        const build = spawnSync('docker', args, { stdio: 'inherit' });
        if (build.status !== 0) throw new Error('Docker build failed');
        console.log(`   ✅ Docker build & push successful`);
    } catch (e) {
        throw new Error(`Docker build failed: ${e.message}`);
    }
}

// ==========================================
// 3. Core Logic
// ==========================================

function getContext(config) {
  // Detection logic based on config
  const isGHA = process.env.GITHUB_ACTIONS === 'true';
  
  let branch = 'unknown';
  let sha = 'unknown';
  let isTag = false;
  let refType = 'branch';
  let actor = process.env.USER || 'local';
  let repo = 'local/repo';

  if (isGHA) {
    branch = process.env.GITHUB_REF_NAME;
    sha = process.env.GITHUB_SHA;
    isTag = process.env.GITHUB_REF_TYPE === 'tag';
    refType = process.env.GITHUB_REF_TYPE;
    actor = process.env.GITHUB_ACTOR;
    repo = process.env.GITHUB_REPOSITORY;
  } else {
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
      sha = execSync('git rev-parse HEAD').toString().trim();
      actor = execSync('git config user.name').toString().trim();
      // Basic repo detecion
      try {
        const remote = execSync('git remote get-url origin').toString().trim();
        repo = remote.split('/').slice(-2).join('/').replace('.git', '').trim();
      } catch (e) {
          // ignore
      }
    } catch (e) {
      console.warn("Git detection failed, using defaults");
    }
  }

  // Environment Mapper based on config.branches
  let env = 'dev'; // default fallback
  if (config.branches) {
    if (config.branches[branch]) {
      env = config.branches[branch].environment;
    } else if (config.branches.main && (branch === 'main' || isTag)) {
      env = config.branches.main.environment || 'prod';
    } else if (config.branches.develop && branch === 'develop') {
      env = config.branches.develop.environment || 'pre';
    } else if (config.branches.default) {
        env = config.branches.default.environment || 'dev';
    }
  } else {
      // Hardcoded fallback if config missing
      if (branch === 'main' || isTag) env = 'prod';
      else if (branch === 'develop') env = 'pre';
  }

  return {
    platform: isGHA ? 'github_actions' : 'local',
    branch,
    sha,
    version: isTag ? branch : sha.substring(0, 7), // Simplified version
    isTag,
    refType,
    env,
    github_actor: actor,
    github_token: process.env.GITHUB_TOKEN, // Secrets should be passed via env
    github_repository: repo
  };
}

async function main() {
  const op = process.argv[2] || 'run';

  // 1. Load Config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config missing: ${CONFIG_PATH}`);
    process.exit(1);
  }
  
  let configStr = fs.readFileSync(CONFIG_PATH, 'utf8');
  let config;
  
  // Try importing 'yaml' if available (in CI with deps installed), else fallback
  try {
    const yaml = await import('yaml');
    config = yaml.parse(configStr);
  } catch (e) {
    // console.log("Using zero-dep YAML parser fallback");
    config = simpleYamlParse(configStr);
  }

  // 2. Resolve Context
  const context = getContext(config);
  
  if (op === 'config') {
    console.log("Resolved Config & Context:");
    console.log(JSON.stringify({ context, config }, null, 2));
    return;
  }
  
  if (op === 'context') {
      console.log(JSON.stringify(context, null, 2));
      return;
  }

  console.log(`🚀 Starting CI/CD Runner`);
  console.log(`   Platform: ${context.platform}`);
  console.log(`   Branch:   ${context.branch}`);
  console.log(`   Env:      ${context.env}`);
  console.log(`========================================`);

  // 3. Run Checks configuration
  let pipelineFailed = false;
  
  if (config.checks) {
    for (const [key, check] of Object.entries(config.checks)) {
      
      // Evaluate Condition (Basic)
      if (check.condition) {
          // Replace config refs
          const evalStr = interpolate(check.condition, context)
              .replace(/github\.event_name/g, `'${process.env.GITHUB_EVENT_NAME || 'push'}'`)
              .replace(/github\.ref_type/g, `'${context.refType}'`)
              .replace(/github\.ref/g, `'${process.env.GITHUB_REF || ''}'`);
          
          try {
              if (!eval(evalStr)) {
                  // console.log(`[STEP] ${check.name} (Skipped)`);
                  continue;
              }
          } catch (e) {
              console.warn(`   Condition check failed (${evalStr}), executing anyway.`);
          }
      }

      console.log(`\n[STEP] ${check.name} (${key})`);

      // Specialized handler for 'build' step if commands are just placeholders
      if (key === 'build' && check.commands && check.commands[0] && check.commands[0].includes('echo')) { // Heuristic
          // If this is the docker build step, use our specialized function
          try {
              runDockerBuild(config, context);
          } catch (err) {
              console.error(`   Build failed: ${err.message}`);
              if (check.required !== false) {
                  pipelineFailed = true;
                  break;
              }
          }
          continue;
      }

      if (check.commands) {
        for (const cmd of check.commands) {
          try {
            runCommand(interpolate(cmd, context), ROOT_DIR, check.env || {});
          } catch (err) {
            console.error(`   Step failed: ${err.message}`);
            if (check.required !== false) {
              pipelineFailed = true;
              break;
            } else {
              console.log(`   Continuing as step is not required...`);
            }
          }
        }
        if (pipelineFailed) break;
      }
    }
  }

  // 5. Final Status & Notification
  if (pipelineFailed) {
    console.error(`\n❌ Pipeline Failed`);
    await sendNotification(config, context, 'failed', 'CI Pipeline failed during execution.');
    process.exit(1);
  } else {
    console.log(`\n✅ Pipeline Finished Successfully`);
    await sendNotification(config, context, 'success', 'CI Pipeline completed successfully.');
  }
}

main();
