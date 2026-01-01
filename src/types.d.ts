// Environment variables type definition for Cloudflare Worker
interface Env {
  // KV Storage
  KV_STORAGE: KVNamespace;

  // QStash signature verification
  QSTASH_CURRENT_SIGNING_KEY: string;
  QSTASH_NEXT_SIGNING_KEY: string;
  SKIP_SIGNATURE_VERIFY?: string;
  SIGNATURE_EXPIRATION_WINDOW?: string;

  // Axiom logging
  AXIOM_TOKEN?: string;
  AXIOM_ORG_ID?: string;
  AXIOM_DATASET?: string;

  // Environment
  NODE_ENV?: string;

  // Upstash Redis fallback
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;

  // Northflank Redis
  NF_REDIS_URL?: string;
  NF_REDIS_PASSWORD?: string;
}

interface Instance {
  id: string;
  url: string;
  hostname: string;
  region?: string;
  startedAt: number;
  lastHeartbeat: number;
  status: 'active' | 'offline';
}

// Extend global for worker context
declare global {
  declare const __VERSION__: string;
  // Worker ID for testing
  var WORKER_ID: string | undefined;
  var __QSTASH_MOCK_VERIFY__: any;
}