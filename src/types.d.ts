// Environment variables type definition for Cloudflare Worker
interface Env {
  // KV Storage
  KV_STORAGE: KVNamespace;

  // QStash signature verification
  QSTASH_CURRENT_SIGNING_KEY: string;
  SKIP_SIGNATURE_VERIFY?: string;

  // Axiom logging
  AXIOM_TOKEN?: string;
  AXIOM_ORG_ID?: string;
  AXIOM_DATASET?: string;

  // Environment
  NODE_ENV?: string;

  // Upstash Redis fallback
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

// Extend global for worker context
declare global {
  // Worker ID for testing
  var WORKER_ID: string | undefined;
}