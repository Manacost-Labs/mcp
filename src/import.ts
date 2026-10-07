import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { loadConfig, sourceIds } from './config.js';
import { openDatabase } from './database.js';
import { ContentStore } from './content/store.js';
import { storeTelegramUpdate } from './sources/telegram.js';

const itemSchema = z.object({ source: z.enum(sourceIds), externalId: z.string().min(1).max(2048), url: z.url(),
  title: z.string().min(1).max(2000), text: z.string().max(2000000), publishedAt: z.string().optional(), updatedAt: z.string().optional(),
  metadata: z.record(z.string(), z.json()) });
process.umask(0o077);
const config = loadConfig(), db = openDatabase(config.databasePath), store = new ContentStore(db);
const [format, path] = process.argv.slice(2);
if (!path || !['content', 'telegram-updates'].includes(format ?? '')) throw new Error('Usage: npm run import -- content|telegram-updates /absolute/path/to/export.jsonl');
let imported = 0;
try {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > 3_000_000) throw new Error('Export line too large');
    const item: unknown = JSON.parse(line);
    if (format === 'telegram-updates') storeTelegramUpdate(store, item, config.channelIds);
    else store.put(itemSchema.parse(item));
    imported++;
  }
  console.log(`Imported ${imported} records.`);
} finally { db.close(); }
