import { load } from 'cheerio';
import { z } from 'zod';
import type { Config, Website } from '../config.js';
import { ContentStore } from '../content/store.js';
import { extractPage, htmlText, wordPressBody } from '../content/extract.js';
import { fetchBounded, fetchJson, SourceError } from '../http.js';

const wpPost = z.object({ id: z.number(), link: z.string(), date_gmt: z.string().optional(), modified_gmt: z.string().optional(),
  title: z.object({ rendered: z.string(), raw: z.string().optional() }),
  content: z.object({ rendered: z.string(), raw: z.string().optional(), protected: z.boolean().optional() }),
  excerpt: z.object({ rendered: z.string() }).optional(),
  categories: z.array(z.number()).optional(), tags: z.array(z.number()).optional(),
  slug: z.string().optional(), status: z.string().optional(), author: z.number().optional(),
  featured_media: z.number().optional(), yoast_head_json: z.record(z.string(), z.unknown()).optional(),
});

export function sameSiteUrl(raw: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw, baseUrl), base = new URL(baseUrl);
    if (url.origin !== base.origin || url.username || url.password || url.search || /\/(?:wp-admin|wp-json|api|oauth|logout|login)(?:\/|$)/i.test(url.pathname)) return null;
    if (/\.(?:png|jpe?g|webp|gif|svg|pdf|zip|css|js|mp4|mp3)$/i.test(url.pathname)) return null;
    url.hash = ''; return url.href;
  } catch { return null; }
}

export class WebsiteIngestor {
  constructor(private store: ContentStore, private config: Config, private fetcher: typeof fetch = fetch) {}

  private remember(site: Website, raw: string) {
    const url = sameSiteUrl(raw, site.baseUrl);
    if (url) this.store.db.prepare('INSERT OR IGNORE INTO crawl_urls(source,url) VALUES(?,?)').run(site.id, url);
  }
  private wpHeaders(site: Website): Record<string, string> {
    if (Boolean(site.username) !== Boolean(site.password)) throw new SourceError('WORDPRESS_CREDENTIALS_INCOMPLETE');
    return site.username && site.password ? { Authorization: `Basic ${Buffer.from(`${site.username}:${site.password}`).toString('base64')}` } : {};
  }

  async getWordPressContent(site: Website, type: 'posts' | 'pages', postId: number) {
    if (!site.username || !site.password) throw new SourceError('FULL_CONTENT_CREDENTIALS_REQUIRED');
    const url = new URL(`/wp-json/wp/v2/${type}/${postId}?context=edit`, site.apiUrl ?? site.baseUrl);
    const result = await fetchJson(url, { headers: this.wpHeaders(site) }, this.fetcher);
    const post = wpPost.safeParse(result.data);
    if (!post.success || post.data.content.raw === undefined) throw new SourceError('WORDPRESS_RAW_CONTENT_MISSING');
    const p = post.data;
    const raw = p.content.raw!;
    return this.store.put({ source: site.id, externalId: `wp:${type}:${p.id}`, url: p.link,
      title: htmlText(p.title.raw ?? p.title.rendered) || p.slug || `WordPress #${p.id}`, text: htmlText(wordPressBody(raw)),
      publishedAt: p.date_gmt ? `${p.date_gmt}Z` : undefined, updatedAt: p.modified_gmt ? `${p.modified_gmt}Z` : undefined,
      metadata: { kind: type === 'posts' ? 'article' : 'page', access: 'full',
        paid: /\[(?:vip_locker|mtp_locker)\b|wp:svl\/locker/i.test(raw), categories: p.categories, tags: p.tags,
        excerpt: htmlText(p.excerpt?.rendered ?? ''), seo: p.yoast_head_json } });
  }

  async wordpress(site: Website) {
    const headers = this.wpHeaders(site), full = Boolean(site.username && site.password);
    for (const type of ['posts', 'pages'] as const) {
      const stateKey = `${site.id}:wp:${type}`;
      const state = this.store.state(stateKey);
      let page = Number(state?.cursor ?? 1);
      if (!Number.isSafeInteger(page) || page < 1) page = 1;
      for (let attempt = 0; attempt < this.config.wpPagesPerSync; attempt++, page++) {
        const url = new URL('/wp-json/wp/v2/' + type, site.apiUrl ?? site.baseUrl);
        url.search = new URLSearchParams({ per_page: '20', page: String(page), order: 'asc', orderby: 'id', ...(full ? { context: 'edit' } : {}) }).toString();
        let result: Awaited<ReturnType<typeof fetchJson>>;
        try { result = await fetchJson(url, { headers }, this.fetcher); }
        catch (error) {
          if (error instanceof SourceError && error.code === 'UPSTREAM_HTTP_400' && page > 1) {
            this.store.status(stateKey, null, '1'); break;
          }
          throw error;
        }
        const posts = z.array(wpPost).safeParse(result.data);
        if (!posts.success) throw new SourceError('WORDPRESS_INVALID_RESPONSE');
        this.store.db.transaction(() => {
          for (const post of posts.data) {
            const raw = post.content.raw;
            if (full && raw === undefined) throw new SourceError('WORDPRESS_RAW_CONTENT_MISSING');
            const body = raw === undefined ? post.content.rendered : wordPressBody(raw);
            const paid = /\[(?:vip_locker|mtp_locker)\b|wp:svl\/locker|svl-locker|svl_locked/i.test(raw ?? post.content.rendered);
            this.store.put({ source: site.id, externalId: `wp:${type}:${post.id}`, url: post.link,
              title: htmlText(post.title.raw ?? post.title.rendered) || post.slug || `WordPress #${post.id}`, text: htmlText(body),
              publishedAt: post.date_gmt ? `${post.date_gmt}Z` : undefined, updatedAt: post.modified_gmt ? `${post.modified_gmt}Z` : undefined,
              metadata: { kind: type === 'posts' ? 'article' : 'page', access: raw !== undefined ? 'full' : site.id === 'koloda' || paid ? 'excerpt' : 'public',
                paid, categories: post.categories, tags: post.tags, slug: post.slug, status: post.status, authorId: post.author,
                featuredMediaId: post.featured_media, excerpt: htmlText(post.excerpt?.rendered ?? ''), seo: post.yoast_head_json } });
            this.remember(site, post.link);
          }
        })();
        const totalPages = Number(result.headers.get('x-wp-totalpages'));
        if (!posts.data.length || (totalPages > 0 && page >= totalPages) || (!totalPages && posts.data.length < 20)) {
          this.store.status(stateKey, null, '1'); break;
        }
        this.store.status(stateKey, null, String(page + 1));
      }
    }
    // Taxonomies expose the site's editorial structure without user records or settings.
    for (const type of ['categories', 'tags']) {
      const key = `${site.id}:wp:${type}`;
      let page = Number(this.store.state(key)?.cursor || 1);
      if (!Number.isSafeInteger(page) || page < 1) page = 1;
      for (let i = 0; i < this.config.wpPagesPerSync; i++, page++) {
        let result: Awaited<ReturnType<typeof fetchJson>>;
        try { result = await fetchJson(new URL(`/wp-json/wp/v2/${type}?per_page=100&page=${page}`, site.apiUrl ?? site.baseUrl), { headers }, this.fetcher); }
        catch (error) {
          if (page > 1 && error instanceof SourceError && error.code === 'UPSTREAM_HTTP_400') { this.store.status(key, null, '1'); break; }
          throw error;
        }
        if (!Array.isArray(result.data)) throw new SourceError('WORDPRESS_TAXONOMY_INVALID_RESPONSE');
        this.store.put({ source: site.id, externalId: `taxonomy:${type}:${page}`, url: site.baseUrl,
          title: `${type}: ${site.id} (${page})`, text: JSON.stringify(result.data.map(t => ({ id: t.id, name: t.name, slug: t.slug, description: t.description, count: t.count, link: t.link }))),
          metadata: { kind: 'taxonomy', access: 'public', taxonomy: type, page } });
        if (result.data.length < 100 || page >= Number(result.headers.get('x-wp-totalpages'))) { this.store.status(key, null, '1'); break; }
        this.store.status(key, null, String(page + 1));
      }
    }
    if (site.id === 'koloda' && !full) throw new SourceError('PAID_CONTENT_CREDENTIALS_REQUIRED');
  }

  async hearthpulse(site: Website) {
    const result = await fetchJson(`${site.baseUrl}/api/articles`, {}, this.fetcher);
    const catalogue = z.object({ articles: z.array(z.object({ id: z.union([z.string(), z.number()]), title: z.string(),
      url: z.string(), excerpt: z.string().optional(), date: z.string().optional(), tag: z.string().optional(), mode: z.string().optional(), image: z.string().optional() })) }).safeParse(result.data);
    if (!catalogue.success) throw new SourceError('HEARTHPULSE_ARTICLES_INVALID_RESPONSE');
    for (const article of catalogue.data.articles) this.store.put({ source: 'hearthpulse', externalId: `article:${article.id}`,
      url: article.url, title: article.title, text: htmlText(article.excerpt ?? ''), publishedAt: article.date,
      metadata: { kind: 'article', access: 'excerpt', tag: article.tag, mode: article.mode, image: article.image } });
  }

  async discover(site: Website) {
    this.remember(site, site.baseUrl + '/');
    const stateKey = `${site.id}:discovery`;
    const home = await fetchBounded(site.baseUrl + '/', {}, this.fetcher);
    const page = extractPage(home.text, site.baseUrl + '/');
    for (const link of page.metadata.navigation) if (link.url) this.remember(site, link.url);
    const seed = this.store.db.prepare('INSERT OR IGNORE INTO crawl_sitemaps(source,url) VALUES(?,?)');
    seed.run(site.id, `${site.baseUrl}/sitemap.xml`); seed.run(site.id, `${site.baseUrl}/wp-sitemap.xml`);
    const queue = this.store.db.prepare('SELECT url FROM crawl_sitemaps WHERE source=? AND (last_fetch IS NULL OR last_fetch<?) ORDER BY last_fetch IS NOT NULL,last_fetch LIMIT 20')
      .all(site.id, new Date(Date.now() - 6 * 3600_000).toISOString()) as { url: string }[];
    let found = false;
    for (const { url } of queue) {
      try {
        const xml = await fetchBounded(url, {}, this.fetcher);
        const $ = load(xml.text, { xml: true });
        if (!$('urlset,sitemapindex').length) throw new SourceError('INVALID_SITEMAP_XML');
        found = true;
        $('sitemap > loc').each((_i, el) => {
          try {
            const next = new URL($(el).text().trim());
            if (next.origin === new URL(site.baseUrl).origin && !next.username && !next.password && !next.search && !next.hash) seed.run(site.id, next.href);
          } catch { /* Malformed sitemap entries do not become fetch targets. */ }
        });
        $('url > loc').each((_i, el) => this.remember(site, $(el).text().trim()));
        this.store.db.prepare('UPDATE crawl_sitemaps SET last_fetch=?,error=NULL WHERE source=? AND url=?').run(new Date().toISOString(), site.id, url);
      } catch {
        this.store.db.prepare('UPDATE crawl_sitemaps SET last_fetch=?,error=? WHERE source=? AND url=?').run(new Date().toISOString(), 'SITEMAP_FETCH_FAILED', site.id, url);
      }
    }
    // RSS is useful for the historical domain when the REST API is unavailable.
    try {
      const feed = await fetchBounded(`${site.baseUrl}/feed/`, {}, this.fetcher), $ = load(feed.text, { xml: true });
      $('item').each((_i, el) => {
        const item = $(el), url = item.find('link').text().trim(); this.remember(site, url);
        const body = item.find('content\\:encoded').text() || item.find('description').text();
        if (sameSiteUrl(url, site.baseUrl)) this.store.put({ source: site.id, externalId: `rss:${url}`, url,
          title: item.find('title').text(), text: htmlText(body), publishedAt: Number.isNaN(Date.parse(item.find('pubDate').text())) ? undefined : new Date(item.find('pubDate').text()).toISOString(),
          metadata: { kind: 'article', access: 'public', importedFrom: 'rss' } });
      });
    } catch { /* RSS is optional; the homepage and sitemap remain available. */ }
    const available = found || Boolean((this.store.db.prepare('SELECT count(*) AS n FROM crawl_sitemaps WHERE source=? AND last_fetch IS NOT NULL AND error IS NULL').get(site.id) as { n: number }).n);
    this.store.status(stateKey, available ? null : 'SITEMAP_UNAVAILABLE');
  }

  async crawl(site: Website) {
    const rows = this.store.db.prepare('SELECT url FROM crawl_urls WHERE source=? ORDER BY last_fetch IS NOT NULL,last_fetch,url LIMIT ?')
      .all(site.id, this.config.htmlPagesPerSync) as { url: string }[];
    let successes = 0;
    for (const row of rows) {
      try {
        const result = await fetchBounded(row.url, {}, this.fetcher);
        if (!result.headers.get('content-type')?.includes('text/html')) throw new SourceError('EXPECTED_HTML_PAGE');
        const page = extractPage(result.text, row.url);
        const existing = this.store.db.prepare("SELECT id,metadata FROM content WHERE source=? AND url=? AND external_id LIKE 'wp:%' LIMIT 1")
          .get(site.id, row.url) as { id: string; metadata: string } | undefined;
        if (existing) this.store.db.prepare('UPDATE content SET metadata=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(existing.metadata), page: page.metadata }), existing.id);
        else this.store.put({ source: site.id, externalId: `page:${row.url}`, url: row.url, ...page });
        for (const link of page.metadata.navigation) if (link.url) this.remember(site, link.url);
        this.store.db.prepare('UPDATE crawl_urls SET last_fetch=?,error=NULL WHERE source=? AND url=?').run(new Date().toISOString(), site.id, row.url);
        successes++;
      } catch (error) {
        this.store.db.prepare('UPDATE crawl_urls SET last_fetch=?,error=? WHERE source=? AND url=?')
          .run(new Date().toISOString(), error instanceof SourceError ? error.code : 'PAGE_FETCH_FAILED', site.id, row.url);
      }
    }
    this.store.status(`${site.id}:html`, rows.length && !successes ? 'HTML_CRAWL_FAILED' : null);
  }

  async sync(site: Website) {
    let error: string | null = null;
    try {
      if (site.id === 'hearthpulse') await this.hearthpulse(site);
      else if (!(site.id === 'old-koloda' && this.config.legacyDatabasePath)) await this.wordpress(site);
    }
    catch (caught) { error = caught instanceof SourceError ? caught.code : 'CONTENT_SYNC_FAILED'; }
    try { await this.discover(site); await this.crawl(site); }
    catch (caught) { error ??= caught instanceof SourceError ? caught.code : 'WEBSITE_SYNC_FAILED'; }
    this.store.status(site.id, error);
  }
}
