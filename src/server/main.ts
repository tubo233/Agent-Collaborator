import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { createApp } from './http.js';
import { acquireDaemonLock } from './lock.js';

const port = Number(process.env.AGENT_COLLABORATOR_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('AGENT_COLLABORATOR_PORT must be an integer between 1 and 65535');
const dataDir = resolve(
  process.env.AGENT_COLLABORATOR_DATA_DIR ?? join(homedir(), '.agent-collaborator'),
);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const unlock = acquireDaemonLock(join(dataDir, 'daemon-lock.sqlite'));
let store: Store;
try {
  store = new Store(join(dataDir, 'board.sqlite'));
} catch (error) {
  unlock();
  throw error;
}
const webDir = fileURLToPath(new URL('../web', import.meta.url));
const { server, closeClients } = createApp(store, {
  port,
  webDir,
  dev: process.argv.includes('--dev'),
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  closeClients();
  server.close(() => {
    store.close();
    unlock();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => {
    server.closeAllConnections();
    store.close();
    unlock();
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('error', (error) => {
  console.error(error.message);
  store.close();
  unlock();
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Agent-Collaborator v0.1.0 • http://127.0.0.1:${port}`);
  console.log(`Local data: ${dataDir}`);
  console.log('Manual coordination only: task text never launches an agent or shell.');
});
