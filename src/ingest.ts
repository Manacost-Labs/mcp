import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { openDatabase } from './database.js';
import { ContentStore } from './content/store.js';
import { WebsiteIngestor } from './sources/websites.js';
import { syncSocial } from './sources/social.js';
import { syncTelegramPublic } from './sources/telegram.js';
import { syncLegacyArchive } from './sources/legacy.js';

export async function ingest(config: Config, store: ContentStore, fetcher: typeof fetch = fetch) {
  const ingestor = new WebsiteIngestor(store, config, fetcher);
  // Serialize source imports to avoid a crawl surge on the shared production server.
  await syncSocial(config, store, fetcher);
  await syncTelegramPublic(config, store, fetcher);
  syncLegacyArchive(config, store);
  for (const site of config.websites) await ingestor.sync(site);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const config = loadConfig(), db = openDatabase(config.databasePath);
  try { const store = new ContentStore(db); await ingest(config, store); console.log(JSON.stringify(store.overview())); }
  finally { db.close(); }
}
