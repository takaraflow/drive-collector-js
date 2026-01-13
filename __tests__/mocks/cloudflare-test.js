import worker from '../../src/index.js';

const kvStore = new Map();

const kvNamespace = {
  async get(key) {
    return kvStore.get(key) ?? null;
  },
  async put(key, value) {
    kvStore.set(key, value);
  },
  async delete(key) {
    kvStore.delete(key);
  },
  async list() {
    return { keys: [] };
  }
};

export const env = {
  KV_STORAGE: kvNamespace,
  QSTASH_CURRENT_SIGNING_KEY: 'test-key',
  QSTASH_NEXT_SIGNING_KEY: 'test-key',
  SKIP_SIGNATURE_VERIFY: 'true',
  NODE_ENV: 'test'
};

export function createExecutionContext() {
  const tasks = [];
  return {
    _tasks: tasks,
    waitUntil(promise) {
      tasks.push(Promise.resolve(promise));
    },
    passThroughOnException() {}
  };
}

export async function waitOnExecutionContext(ctx) {
  if (!ctx || !ctx._tasks) return;
  await Promise.all(ctx._tasks);
}

export const SELF = {
  async fetch(input, init) {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const ctx = createExecutionContext();
    return worker.fetch(request, env, ctx);
  }
};
