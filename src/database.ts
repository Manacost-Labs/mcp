import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_pending (hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, grant_id TEXT);
    CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, credential TEXT NOT NULL, resource TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id), kind TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, published_at TEXT, updated_at TEXT, fetched_at TEXT NOT NULL, metadata TEXT NOT NULL, UNIQUE(source, external_id));
    CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(title, text, content='content', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER IF NOT EXISTS content_ai AFTER INSERT ON content BEGIN INSERT INTO content_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text); END;
    CREATE TRIGGER IF NOT EXISTS content_ad AFTER DELETE ON content BEGIN INSERT INTO content_fts(content_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text); END;
    CREATE TRIGGER IF NOT EXISTS content_au AFTER UPDATE ON content BEGIN
      INSERT INTO content_fts(content_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text);
      INSERT INTO content_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text);
    END;
    CREATE TABLE IF NOT EXISTS source_state (source TEXT PRIMARY KEY, last_attempt TEXT, last_success TEXT, error TEXT, cursor TEXT);
    CREATE TABLE IF NOT EXISTS telegram_updates (id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS crawl_urls (source TEXT NOT NULL,url TEXT NOT NULL,last_fetch TEXT,error TEXT,PRIMARY KEY(source,url));
    CREATE TABLE IF NOT EXISTS crawl_sitemaps (source TEXT NOT NULL,url TEXT NOT NULL,last_fetch TEXT,error TEXT,PRIMARY KEY(source,url));
    CREATE INDEX IF NOT EXISTS content_source ON content(source);
    CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);
  `);
  return db;
}
export type Db = ReturnType<typeof openDatabase>;
