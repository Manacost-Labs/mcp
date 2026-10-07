import { createHash } from 'node:crypto';
import type { Db } from '../database.js';
import type { SourceId } from '../config.js';

export type ContentItem = { source: SourceId; externalId: string; url: string; title: string; text: string;
  publishedAt?: string; updatedAt?: string; metadata: Record<string, unknown> };
export const contentId = (source: SourceId, externalId: string) => createHash('sha256').update(`${source}:${externalId}`).digest('hex').slice(0, 32);
type ContentRow = { id: string; source: string; url: string; title: string; text: string; published_at: string | null; updated_at: string | null; fetched_at: string; metadata: string };
type SourceState = { source: string; last_attempt: string | null; last_success: string | null; error: string | null; cursor: string | null };

export class ContentStore {
  constructor(public readonly db: Db) {}
  put(item: ContentItem) {
    if (!item.title || item.text.length > 2_000_000) throw new Error('Invalid content size');
    const id = contentId(item.source, item.externalId);
    this.db.prepare(`INSERT INTO content(id,source,external_id,url,title,text,published_at,updated_at,fetched_at,metadata)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,external_id) DO UPDATE SET url=excluded.url,title=excluded.title,
      text=excluded.text,published_at=excluded.published_at,updated_at=excluded.updated_at,fetched_at=excluded.fetched_at,metadata=excluded.metadata`)
      .run(id, item.source, item.externalId, item.url, item.title, item.text, item.publishedAt ?? null, item.updatedAt ?? null, new Date().toISOString(), JSON.stringify(item.metadata));
    return id;
  }
  search(input: { query?: string; source?: SourceId; kind?: string; paid?: boolean; since?: string; until?: string; limit: number; offset: number }) {
    const terms = (input.query ?? '').match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
    const search = terms.map(term => `"${term}"*`).join(' AND ');
    const where: string[] = [], params: unknown[] = [];
    if (search) { where.push('content_fts MATCH ?'); params.push(search); }
    if (input.source) { where.push('c.source=?'); params.push(input.source); }
    if (input.kind) { where.push("json_extract(c.metadata,'$.kind')=?"); params.push(input.kind); }
    if (input.paid !== undefined) { where.push("json_extract(c.metadata,'$.paid')=?"); params.push(input.paid ? 1 : 0); }
    if (input.since) { where.push('c.published_at>=?'); params.push(input.since); }
    if (input.until) { where.push('c.published_at<=?'); params.push(input.until); }
    const from = `content c${search ? ' JOIN content_fts ON c.rowid=content_fts.rowid' : ''}`;
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT count(*) AS count FROM ${from} ${clause}`).get(...params) as { count: number }).count;
    const rows = this.db.prepare(`SELECT c.* FROM ${from} ${clause} ORDER BY ${search ? 'bm25(content_fts),' : ''} c.published_at DESC,c.id LIMIT ? OFFSET ?`)
      .all(...params, input.limit, input.offset) as ContentRow[];
    return { items: rows.map(row => this.serialize(row, row.text.slice(0, 500))), total, nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null };
  }
  get(id: string, offset = 0, length = 16000) {
    const row = this.db.prepare('SELECT * FROM content WHERE id=?').get(id) as ContentRow | undefined;
    if (!row) return null;
    return { ...this.serialize(row, row.text.slice(offset, offset + length)), textLength: row.text.length,
      nextOffset: offset + length < row.text.length ? offset + length : null };
  }
  private serialize(row: ContentRow, text: string) {
    return { id: row.id, source: row.source, url: row.url, title: row.title, text, publishedAt: row.published_at,
      updatedAt: row.updated_at, fetchedAt: row.fetched_at, metadata: JSON.parse(row.metadata) as Record<string, unknown> };
  }
  state(source: string): SourceState | undefined { return this.db.prepare('SELECT * FROM source_state WHERE source=?').get(source) as SourceState | undefined; }
  status(source: string, error: string | null, cursor?: string | null) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO source_state(source,last_attempt,last_success,error,cursor) VALUES(?,?,?,?,?)
      ON CONFLICT(source) DO UPDATE SET last_attempt=excluded.last_attempt,
      last_success=CASE WHEN excluded.error IS NULL THEN excluded.last_success ELSE source_state.last_success END,
      error=excluded.error,cursor=COALESCE(excluded.cursor,source_state.cursor)`)
      .run(source, now, error ? null : now, error, cursor ?? null);
  }
  overview(source?: SourceId) {
    const sources = this.db.prepare(`SELECT source, count(*) AS items,
      sum(CASE WHEN json_extract(metadata,'$.access')='full' THEN 1 ELSE 0 END) AS fullContent,
      sum(CASE WHEN json_extract(metadata,'$.paid')=1 THEN 1 ELSE 0 END) AS paidItems,
      max(fetched_at) AS latestFetch FROM content ${source ? 'WHERE source=?' : ''} GROUP BY source`)
      .all(...(source ? [source] : []));
    const states = this.db.prepare(`SELECT * FROM source_state ${source ? 'WHERE source=?' : ''}`).all(...(source ? [source] : []));
    return { sources, states };
  }
}
