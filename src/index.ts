import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { createApp } from './app.js';
import { ingest } from './ingest.js';

process.umask(0o077);
const config = loadConfig(), db = openDatabase(config.databasePath);
const { app, store, oauth } = createApp(config, db);
let running: Promise<void> | undefined, stopping = false;
const synchronize = () => {
  if (running || stopping) return;
  running = ingest(config, store).then(() => oauth.cleanup()).catch(() => {
    console.error('Source synchronization failed; inspect get_source_status.');
  }).finally(() => { running = undefined; });
};
const listener = app.listen(config.port, config.host, () => {
  console.log(`Manacost MCP listening on ${config.host}:${config.port}`);
  synchronize();
});
const timer = setInterval(synchronize, config.ingestInterval);
timer.unref();
const shutdown = async () => {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 30_000); deadline.unref();
  await new Promise<void>(resolve => listener.close(() => resolve()));
  await running;
  db.close(); clearTimeout(deadline);
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
