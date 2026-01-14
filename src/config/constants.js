/**
 * 常量配置文件
 * 包含所有硬编码的常数值
 */

// Load Balancer 常量
export const ROUND_ROBIN_KEY = 'lb:round_robin_index';
export const HEARTBEAT_TIMEOUT = 15 * 60 * 1000; // 15分钟
export const TELEGRAM_LOCK_KEY = 'lock:telegram_client';

// 临时调度配置
export const TEMPORARY_SCHEDULING = {
  LOCK_PREFIX: 'temp:msg:',
  LOCK_TTL_SECONDS: 300, // 5分钟
  TASK_TYPES: {
    UPLOAD: '/api/tasks/upload',
    BATCH: '/api/tasks/batch'
  },
  LOCK_FIELDS: {
    INSTANCE_ID: ['originInstanceId', 'instanceId', 'instanced', 'ownerId', 'owner', 'id'],
    TIMESTAMP: ['timestamp', 'acquiredAt', 'acquired_at'],
    TTL: ['ttl', 'expiresIn']
  }
};

// 请求大小限制
export const MAX_JSON_SIZE = 1024 * 1024; // 1MB JSON 解析限制
export const MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024; // 10MB body limit to avoid OOM

// 环境变量映射
export const ENV_ALIASES = {
  development: 'dev',
  dev: 'dev',
  production: 'prod',
  prod: 'prod',
  staging: 'pre',
  pre: 'pre'
};

// 签名验证配置
export const SIGNATURE_EXPIRATION_WINDOW_DEFAULT = 900; // 15分钟

// Redis 操作类型
export const REDIS_OPERATIONS = {
  KV_GET: '_kv_get',
  KV_PUT: '_kv_put',
  KV_LIST: '_kv_list',
  REDIS_GET: '_redis_get',
  REDIS_PUT: '_redis_put',
  REDIS_SCAN: '_redis_scan'
};

// 故障转移配置
export const FAILOVER_CONFIG = {
  MAX_FAILURES: 3,
  COOLDOWN_MS: 60000, // 1分钟
  RETRY_DELAY_BASE: 100, // 基础重试延迟
  MAX_RETRIES: 3,
  TIMEOUT_MS: 15000 // 15秒
};

// 日志配置
export const LOG_CONFIG = {
  MAX_VALUE_PREVIEW_LENGTH: 2000,
  CHUNK_SIZE: 20,
  MAX_DEPTH: 10,
  MAX_STRING_LENGTH: 100000
};

// Upstash Scan 限制
export const UPSTASH_SCAN_CONFIG = {
  MAX_ITERATIONS: 100,
  MAX_DURATION_MS: 30000,
  COUNT: 100
};

// 路径映射
export const PATH_MAP = {
  '/api/tasks/download-tasks': '/api/tasks/download',
  '/api/tasks/upload-tasks': '/api/tasks/upload',
  '/api/tasks/media-batch': '/api/tasks/batch'
};

// 健康检查路径
export const HEALTH_CHECK_PATH = '/health';

// API 路径
export const API_PATHS = {
  INSTANCES: '/api/instances',
  DOWNLOAD: '/api/tasks/download'
};

// 响应状态码
export const HTTP_STATUS = {
  OK: 200,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYLOAD_TOO_LARGE: 413,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_SERVER_ERROR: 500
};

// 错误消息
export const ERROR_MESSAGES = {
  ADMIN_TOKEN_NOT_CONFIGURED: 'ADMIN_API_TOKEN 未配置',
  MISSING_AUTHORIZATION_HEADER: '缺少 Authorization 头',
  INVALID_API_TOKEN: '无效的 API Token',
  QSTASH_SIGNING_KEY_NOT_SET: 'QSTASH_CURRENT_SIGNING_KEY 未设置',
  MISSING_SIGNATURE_HEADER: 'Missing Upstash-Signature header',
  SIGNATURE_EXPIRED: 'Signature expired',
  SIGNATURE_VERIFICATION_FAILED: 'Signature verification failed',
  NO_ACTIVE_INSTANCES: 'No active instances available',
  ALL_INSTANCES_FAILED: 'All instances failed',
  CACHE_PROVIDERS_NOT_CONFIGURED: 'CACHE_PROVIDERS not configured',
  UPSTASH_REDIS_NOT_CONFIGURED: 'Upstash Redis not configured',
  INVALID_TIMESTAMP_FORMAT: 'Invalid timestamp format',
  INVALID_EXPIRATION_WINDOW: 'Invalid expiration window configuration',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  REQUEST_BODY_READ_ERROR: 'Request object must have text() or arrayBuffer() method',
  JSON_DATA_TOO_LARGE: 'JSON 数据过大',
  GLOBAL_STATE_NOT_INITIALIZED: 'Global state not initialized. Call initializeGlobalState first.',
  UNSUPPORTED_OPERATION: 'Unsupported operation',
  UNSUPPORTED_REDIS_OPERATION: 'Unsupported Redis operation',
  UNSUPPORTED_CACHE_OPERATION: 'Unsupported operation for CacheService',
  ALL_PROVIDERS_FAILED: 'All providers failed',
  REDIS_COMMAND_TIMEOUT: 'Redis command timed out',
  SCAN_TIMEOUT: 'Upstash Scan 超时',
  SCAN_ERROR: 'Upstash Scan Error',
  FALLBACK_SCAN_FAILED: 'Fallback scan failed',
  NO_KEYS_FOUND: 'No keys found after fallback',
  LOCK_READ_FAILED: '读取锁失败',
  LOCK_EXPIRED: '锁已过期',
  LOCK_MISSING_INSTANCE_INFO: '锁值缺失实例信息',
  LOCK_OWNER_NOT_ACTIVE: '锁持有者不在活跃实例列表',
  INTERNAL_ERROR: 'Internal Server Error',
  JSON_PARSE_FAILED: 'JSON parse failed',
  OBJECT_TOO_DEEP: 'Object too deep',
  STRING_TOO_LONG: 'String too long',
  INVALID_INPUT: '输入不是字符串类型',
  EMPTY_INPUT: '输入为空',
  TEMP_LOCK_NOT_FOUND: '未找到临时调度锁',
  TEMP_LOCK_EXPIRED: '临时调度锁已过期',
  TEMP_LOCK_INVALID: '临时调度锁格式无效',
  TEMP_LOCK_READ_FAILED: '读取临时调度锁失败',
  ORIGIN_INSTANCE_UNAVAILABLE: '原始实例不可用'
};

// 成功消息
export const SUCCESS_MESSAGES = {
  ADMIN_TOKEN_VERIFIED: '✅ 管理员Token验证成功',
  SIGNATURE_VERIFIED: '✅ QStash 签名验证成功',
  SIGNATURE_SKIPPED: '⏭️ 跳过签名验证 (Skipping signature verification)',
  ADMIN_AUTH_SKIPPED: '⏭️ 跳过管理员鉴权 (Skipping admin auth)',
  HEALTH_CHECK_PASSED: 'Health check passed',
  ACTIVE_INSTANCES_FETCHED: '👥 获取活跃实例完成 (Active instances fetched)',
  TARGET_INSTANCE_SELECTED: '🎯 使用锁持有者作为目标实例',
  REQUEST_FORWARDED: '转发请求到实例',
  LOAD_BALANCER_REQUEST_COMPLETED: '负载均衡请求完成',
  CORE_FETCH_DIAGNOSTIC: '核心 Fetch 诊断',
  PROVIDER_STATUS: 'Provider Status',
  PATH_NORMALIZED: '路径规范化',
  GLOBAL_STATE_INITIALIZED: 'Global state initialized',
  REQUEST_RECEIVED: 'Request Received',
  REQUEST_SOURCE_INFO: 'Request Source Info',
  AXIOM_CONFIG_CHECK: 'Axiom 配置检查',
  LB_REQUEST_STARTED: 'LB Request Started',
  HEALTH_CHECK_PASSED_VERBOSE: 'Health check passed',
  INSTANCE_QUERY_FAILED: 'Instance query failed',
  SIGNATURE_VERIFICATION_FAILED_VERBOSE: '签名验证失败',
  NO_ACTIVE_INSTANCES_AVAILABLE: '无活跃实例可用',
  RETURN_503_RESPONSE: '返回 503 响应：无活跃实例可用',
  TARGET_INSTANCE_SELECTED_VERBOSE: 'targetInstance selected',
  HANDLE_REQUEST_FAILED: 'handleRequest 处理失败',
  REDIS_HEALTH_CHECK_SUCCESS: 'Redis 健康检查成功',
  REDIS_HEALTH_CHECK_FAILED: 'CacheService Redis PING 健康检查失败',
  ALL_PROVIDER_HEALTH_CHECK_FAILED: '所有 provider 健康检查失败',
  HEALTH_CHECK_EXCEPTION: '健康检查异常',
  CACHE_SERVICE_OPERATION_FAILED: 'CacheService operation failed',
  LEGACY_PROVIDER_FAILED: 'Legacy provider failed',
  KV_ATOMIC_OPERATION_FAILED: 'KV原子操作异常',
  ALL_KV_RETRIES_FAILED: '所有KV重试失败',
  ALL_RETRIES_FAILED: '所有轮询重试失败',
  ATOMIC_OPERATION_FAILED: '原子轮询操作失败',
  REDIS_COMMAND_RETRY: 'Redis 命令重试',
  REDIS_COMMAND_TIMEOUT_VERBOSE: 'Redis command timed out',
  FORWARD_REQUEST_FAILED: '转发请求失败',
  BACKEND_5XX_ERROR: '后端返回 5xx 错误',
  BACKEND_4XX_ERROR: '后端返回 4xx 错误',
  INSTANCE_RETURN_4XX: '实例返回 4xx 错误，停止重试',
  ALL_INSTANCES_5XX: '所有实例均返回 5xx',
  LOCK_ROUTING_DEBUG: '锁路由调试信息',
  LOCK_READ_FAILED_VERBOSE: '读取锁失败，回退轮询',
  LOCK_NOT_FOUND: '未找到锁或锁已过期，回退轮询',
  LOCK_EXPIRED_VERBOSE: '锁已过期，回退轮询',
  LOCK_MISSING_INFO: '锁值缺失实例信息，回退轮询',
  LOCK_OWNER_NOT_IN_ACTIVE: '锁持有者不在活跃实例列表，回退轮询',
  SCAN_LOCK_KEYS_FAILED: '锁键扫描失败',
  SCAN_LOCK_KEYS_EXCEPTION: '锁键扫描异常',
  DETECTED_LOCK_KEYS: '检测到锁键',
  SCAN_ALL_RAW_KEYS: '扫描到所有原始键',
  NO_KEYS_FOUND_FALLBACK: '未找到键，尝试回退全量扫描',
  FALLBACK_SCAN_RESULT: 'Fallback Scan: Raw keys',
  SCAN_PHASE_NO_KEYS: 'Scan Phase: No keys found after fallback, returning empty array',
  SCAN_PHASE_FILTERED_KEYS: 'Scan Phase: Filtered instance keys',
  FETCH_PHASE_RAW_DATA: 'Fetch Phase: Raw instance data results',
  FETCH_PHASE_PARSED_DATA: 'Fetch Phase: Parsed instance data',
  FETCH_PHASE_INSTANCE_EXPIRED: 'Fetch Phase: Instance expired',
  FULL_KV_CHUNK: 'Full KV chunk',
  DEDUPLICATED_INSTANCES: '去重后实例列表',
  REDIS_ENDPOINT_SUMMARY: 'Redis 终端摘要',
  CACHE_PROVIDERS_CONFIG: '使用 CACHE_PROVIDERS 缓存系统',
  CACHE_SYSTEM_SUMMARY: '使用 CACHE_PROVIDERS 缓存系统',
  HEALTH_CHECK_SUMMARY: 'Health check summary',
  PROVIDER_SUMMARY: 'Provider summary',
  AXIOM_DECISION: 'Axiom decision',
  AXIOM_INSTRUMENT_CALLED: 'instrument() called with Axiom config',
  AXIOM_FALLBACK_MODE: 'fallback mode - calling handler.fetch directly',
  AXIOM_EXPORTER_CONFIG: 'Axiom exporter config',
  AXIOM_ORG_ID_ADDED: '显式加上 Organization ID，这是解决 Dataset 为 0 的杀手锏',
  AXIOM_DEBUG_REQUEST_ID: 'export.default.fetch entered',
  AXIOM_HANDLE_REQUEST_STARTED: 'handleRequest started',
  AXIOM_BEFORE_GET_ACTIVE_INSTANCES: 'Before getActiveInstances',
  AXIOM_AFTER_GET_ACTIVE_INSTANCES: 'After getActiveInstances',
  AXIOM_FINALLY_BLOCK: 'finally block entered',
  AXIOM_FLUSHING_GLOBAL_BUFFER: 'also flushing global logger buffer',
  AXIOM_CALLING_FLUSH_SYNCHRONOUSLY: 'calling flushLogs synchronously',
  TEMP_SCHEDULING_STARTED: '临时调度开始',
  TEMP_SCHEDULING_LOCK_FOUND: '找到临时调度锁',
  TEMP_SCHEDULING_SUCCESS: '使用临时调度锁路由到原始实例',
  TEMP_SCHEDULING_LOCK_EXPIRED: '临时调度锁已过期，回退到轮询',
  TEMP_SCHEDULING_NO_MESSAGE_ID: '无QStash消息ID，回退到轮询',
  TEMP_SCHEDULING_ORIGIN_NOT_ACTIVE: '原始实例不在活跃列表中，回退到轮询',
  TEMP_SCHEDULING_FALLBACK: '临时调度失败，回退到轮询'
};

// 环境变量键名
export const ENV_KEYS = {
  ADMIN_API_TOKEN: 'ADMIN_API_TOKEN',
  QSTASH_CURRENT_SIGNING_KEY: 'QSTASH_CURRENT_SIGNING_KEY',
  QSTASH_NEXT_SIGNING_KEY: 'QSTASH_NEXT_SIGNING_KEY',
  KV_STORAGE: 'KV_STORAGE',
  UPSTASH_REDIS_REST_URL: 'UPSTASH_REDIS_REST_URL',
  UPSTASH_REDIS_REST_TOKEN: 'UPSTASH_REDIS_REST_TOKEN',
  CACHE_PROVIDERS: 'CACHE_PROVIDERS',
  AXIOM_TOKEN: 'AXIOM_TOKEN',
  AXIOM_DATASET: 'AXIOM_DATASET',
  AXIOM_ORG_ID: 'AXIOM_ORG_ID',
  NODE_ENV: 'NODE_ENV',
  VERSION: 'VERSION',
  SKIP_ADMIN_AUTH: 'SKIP_ADMIN_AUTH',
  SKIP_SIGNATURE_VERIFY: 'SKIP_SIGNATURE_VERIFY',
  DEBUG_LOGS: 'DEBUG_LOGS',
  SIGNATURE_EXPIRATION_WINDOW: 'SIGNATURE_EXPIRATION_WINDOW',
  REDIS_URL: 'REDIS_URL'
};

// 测试环境标识
export const TEST_ENVIRONMENTS = {
  TEST: 'test',
  TESTING: 'testing'
};