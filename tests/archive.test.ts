import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/database.js';
import { ContentStore } from '../src/content/store.js';
import { syncLegacyArchive } from '../src/sources/legacy.js';
import { syncTelegramPublic } from '../src/sources/telegram.js';
import { testConfig } from './helpers.js';

test('legacy archive is read-only, paginated, excludes identities and distinguishes previews', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manacost-archive-')), path = join(dir, 'guides.sqlite');
  const source = new Database(path);
  source.exec(`CREATE TABLE guides(id INTEGER PRIMARY KEY,slug TEXT,old_url TEXT,published_at INTEGER,published_iso TEXT,title TEXT,
    description TEXT,keywords TEXT,image TEXT,menu_name TEXT,menu_code TEXT,kind TEXT,kind_slug TEXT,
    short_html TEXT,free_html TEXT,body_html TEXT,body_text TEXT,reply_count INTEGER,user_id TEXT);
    INSERT INTO guides(id,slug,old_url,title,body_html,user_id) VALUES(1,'guide','http://kolodahearthstone.ru/guide?code=hidden','Guide','<p>Archive full body</p>','private-author');
    INSERT INTO guides(id,slug,title,free_html) VALUES(2,'preview','Preview','<p>Preview only</p>');`);
  source.close(); const before = readFileSync(path);
  const db = openDatabase(':memory:'), store = new ContentStore(db), config = testConfig({ OLD_KOLODA_DATABASE_PATH: path });
  try {
    syncLegacyArchive(config, store, 1);
    assert.equal(store.search({ source: 'old-koloda', limit: 10, offset: 0 }).total, 1);
    syncLegacyArchive(config, store, 1);
    const rows = store.search({ source: 'old-koloda', limit: 10, offset: 0 });
    assert.equal(rows.total, 2); assert.ok(!JSON.stringify(rows).includes('private-author'));
    const full = rows.items.find(row => row.title === 'Guide')!;
    assert.equal(full.url, 'https://old.kolodahearthstone.ru/guide');
    assert.equal(full.metadata.access, 'full');
    assert.equal(rows.items.find(row => row.title === 'Preview')!.metadata.access, 'excerpt');
    assert.deepEqual(readFileSync(path), before);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('public Telegram archive refreshes newest posts without resetting its historical cursor', async () => {
  const db = openDatabase(':memory:'), store = new ContentStore(db), calls: string[] = [];
  const config = testConfig({ TELEGRAM_PUBLIC_CHANNELS: 'manacost_ru' });
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url.href);
    const historic = Boolean(url.searchParams.get('before'));
    return new Response(`<div class="tgme_widget_message" data-post="manacost_ru/${historic ? 5 : 20}"><div class="tgme_widget_message_text">${historic ? 'History' : 'News'}<br>text</div><time datetime="2026-10-01T00:00:00Z"></time></div><a class="tme_messages_more" data-before="${historic ? 1 : 10}"></a>`);
  };
  try {
    await syncTelegramPublic(config, store, fetcher); await syncTelegramPublic(config, store, fetcher);
    assert.equal(calls.length, 3); assert.ok(calls[2]!.includes('before=10'));
    assert.equal(store.state('telegram:manacost_ru:archive')?.cursor, '1');
    assert.equal(store.search({ source: 'telegram', limit: 10, offset: 0 }).total, 2);
  } finally { db.close(); }
});
