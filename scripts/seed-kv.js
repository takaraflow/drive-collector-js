import { execSync } from 'child_process';

const now = Date.now();
const instanceData = JSON.stringify({
  id: 'test',
  url: 'http://localhost:8080',
  status: 'active',
  lastHeartbeat: now
});

const command = `npx wrangler kv key put --namespace-id 97804cde982045b78f81ad73fb2fa8bf --local "instance:test" "${instanceData}"`;

console.log('Injecting test instance into local KV...');
execSync(command, { stdio: 'inherit' });
console.log('Test instance injected successfully.');