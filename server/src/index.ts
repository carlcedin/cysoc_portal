// Portal web server: serves the API and the built front end.
import { config, masterKeyBytes } from './config.js';
import { createServer } from './http/core.js';
import { attachSession } from './auth/session.js';
import { closePool, getPool } from './db/index.js';
import './services/escalations.js';
import './services/insights.js';
import './services/requests-reports.js';
import './services/service-admin.js';

masterKeyBytes(); // fail fast if the encryption key is missing or malformed
await (await getPool()).connect().then(c => c.release());

const server = createServer(attachSession);
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.listen(config.port, config.host, () => {
  console.log(`[portal] listening on ${config.host}:${config.port} (${config.integrationMode} mode, public URL ${config.publicUrl})`);
});

const stop = () => server.close(async () => { await closePool(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
