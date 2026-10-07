import Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { ContentStore } from '../content/store.js';
import { htmlText, wordPressBody } from '../content/extract.js';

type Guide = { id: number; slug: string; old_url: string; published_at: number | null; published_iso: string | null;
  title: string; description: string; keywords: string; image: string; menu_name: string; menu_code: string;
  kind: string; kind_slug: string; short_html: string; free_html: string; body_html: string; body_text: string; reply_count: number };

export function syncLegacyArchive(config: Config, store: ContentStore, batchSize = 100) {
  if (!config.legacyDatabasePath) return;
  let db: Database.Database | undefined;
  try {
    db = new Database(config.legacyDatabasePath, { readonly: true, fileMustExist: true });
    const after = Number(store.state('old-koloda:archive')?.cursor ?? 0);
    let last = Number.isSafeInteger(after) && after >= 0 ? after : 0, count = 0;
    const rows = db.prepare(`SELECT id,slug,old_url,published_at,published_iso,title,description,keywords,image,
      menu_name,menu_code,kind,kind_slug,short_html,free_html,body_html,body_text,reply_count
      FROM guides WHERE id>? ORDER BY id LIMIT ?`).iterate(last, batchSize);
    for (const row of rows) {
      const guide = row as Guide;
      const full = Boolean(guide.body_html || guide.body_text);
      const raw = guide.body_html || guide.body_text || guide.free_html || guide.short_html || '';
      const date = guide.published_iso ? new Date(guide.published_iso) : guide.published_at ? new Date(guide.published_at * 1000) : null;
      let url = new URL(`/${encodeURIComponent(guide.slug || String(guide.id))}`, 'https://old.kolodahearthstone.ru');
      try {
        const original = new URL(guide.old_url);
        if (['kolodahearthstone.ru', 'www.kolodahearthstone.ru', 'old.kolodahearthstone.ru'].includes(original.hostname)) url = new URL(original.pathname, url.origin);
      } catch { /* use the archive slug */ }
      store.put({ source: 'old-koloda', externalId: `archive:${guide.id}`, url: url.href,
        title: htmlText(guide.title || '') || guide.slug || `Guide #${guide.id}`, text: htmlText(wordPressBody(raw)),
        publishedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined,
        metadata: { kind: 'article', access: full ? 'full' : 'excerpt', paid: /\[(?:vip_locker|mtp_locker)\b|wp:svl\/locker/i.test(raw) ? true : null,
          acquisition: 'local-readonly-archive', excerpt: htmlText(guide.description || ''), keywords: guide.keywords,
          image: guide.image, menuName: guide.menu_name, menuCode: guide.menu_code, category: guide.kind,
          categorySlug: guide.kind_slug, replyCount: guide.reply_count } });
      last = guide.id; count++;
    }
    store.status('old-koloda:archive', null, String(count < batchSize ? 0 : last));
  } catch { store.status('old-koloda:archive', 'LEGACY_ARCHIVE_UNAVAILABLE'); }
  finally { db?.close(); }
}
