import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import { ContentStore } from '../content/store.js';
import { htmlText } from '../content/extract.js';
import { fetchJson, SourceError } from '../http.js';

const boostyPost = z.object({ id: z.string(), title: z.string().nullish(), createdAt: z.number().optional(),
  hasAccess: z.boolean().optional(), isBlocked: z.boolean().optional(), isPaid: z.boolean().optional(),
  price: z.number().optional(), subscriptionLevel: z.object({ price: z.number().optional() }).passthrough().nullable().optional(),
  teaser: z.array(z.object({ type: z.string(), content: z.unknown().optional() }).passthrough()).optional(),
  data: z.array(z.object({ type: z.string(), content: z.unknown().optional() }).passthrough()).optional() }).passthrough();

function boostyText(content: string): string {
  // Boosty's text blocks encode a Draft.js tuple [text, block type, entities].
  try { const block: unknown = JSON.parse(content); if (Array.isArray(block) && typeof block[0] === 'string') return htmlText(block[0]); } catch { /* plain HTML/text */ }
  return htmlText(content);
}

export class BoostyApi {
  constructor(private config: Config, private fetcher: typeof fetch = fetch) {}
  async posts(limit: number, offset?: string) {
    const url = new URL(`/v1/blog/${this.config.boostyBlog}/post/`, this.config.boostyApiUrl);
    url.searchParams.set('limit', String(limit));
    if (offset) url.searchParams.set('offset', offset);
    let token = this.config.boostyContentToken;
    if (this.config.boostyTokenFile) {
      try { token = readFileSync(this.config.boostyTokenFile, 'utf8').trim(); }
      catch { throw new SourceError('BOOSTY_TOKEN_FILE_UNAVAILABLE'); }
      if (!token || /[\r\n]/.test(token)) throw new SourceError('BOOSTY_TOKEN_FILE_INVALID');
    }
    const { data } = await fetchJson(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, this.fetcher);
    const result = z.object({ data: z.array(boostyPost), extra: z.record(z.string(), z.unknown()).optional() }).safeParse(data);
    if (!result.success) throw new SourceError('BOOSTY_POSTS_INVALID_RESPONSE');
    return { items: result.data.data.map(post => {
      const paid = post.isPaid ?? ((post.price ?? 0) > 0 || (post.subscriptionLevel?.price ?? 0) > 0);
      const full = post.hasAccess === true || (post.hasAccess !== false && !paid && post.isBlocked !== true);
      const parts = full ? post.data : (post.teaser?.length ? post.teaser : post.data);
      const text = (parts ?? []).filter(part => part.type === 'text' && typeof part.content === 'string')
        .map(part => boostyText(part.content as string)).filter(Boolean).join('\n\n');
      return { id: post.id, title: post.title || text.split('\n')[0]?.slice(0, 200) || post.id,
        url: `https://boosty.to/${this.config.boostyBlog}/posts/${post.id}`, text,
        publishedAt: post.createdAt ? new Date(post.createdAt > 1_000_000_000_000 ? post.createdAt : post.createdAt * 1000).toISOString() : undefined,
        access: full ? 'full' : 'excerpt', paid };
    }), pagination: result.data.extra ?? {}, sourceUrl: url.href };
  }
  async analytics(kind: 'subscriptions' | 'post-sales', from?: string, to?: string) {
    const url = new URL(this.config.boostyLocalUrl + (kind === 'subscriptions' ? '/api/analytics' : '/api/boosty/sales/analytics'));
    if (from) url.searchParams.set('from', from);
    if (to) url.searchParams.set('to', to);
    const { data } = await fetchJson(url, {}, this.fetcher);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SourceError('BOOSTY_ANALYTICS_INVALID_RESPONSE');
    if (kind === 'subscriptions') return data;
    // The local sales response contains buyer identities; expose only aggregate post performance.
    const d = data as Record<string, unknown>;
    return { schemaVersion: d.schemaVersion, semantics: d.semantics, from: d.from, to: d.to, summary: d.summary,
      posts: d.posts, coverage: d.coverage, source: d.source, latestImport: d.latestImport };
  }
}

const vkPost = z.object({ id: z.number().int(), owner_id: z.number().int(), date: z.number().int(), text: z.string(),
  likes: z.object({ count: z.number() }).passthrough().optional(), reposts: z.object({ count: z.number() }).passthrough().optional(),
  views: z.object({ count: z.number() }).passthrough().optional(), comments: z.object({ count: z.number() }).passthrough().optional(),
  attachments: z.array(z.unknown()).optional(), is_pinned: z.number().optional() });

export class VkApi {
  constructor(private config: Config, private fetcher: typeof fetch = fetch) {}
  private async call(method: string, input: Record<string, string | number>) {
    if (!this.config.vkToken) throw new SourceError('VK_TOKEN_NOT_CONFIGURED');
    const body = new URLSearchParams({ access_token: this.config.vkToken, v: this.config.vkVersion });
    for (const [key, value] of Object.entries(input)) body.set(key, String(value));
    const { data } = await fetchJson(`https://api.vk.com/method/${method}`, { method: 'POST', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, this.fetcher);
    const result = z.object({ response: z.unknown().optional(), error: z.unknown().optional() }).safeParse(data);
    if (!result.success || result.data.error || !result.data.response) throw new SourceError('VK_API_ERROR');
    return result.data.response;
  }
  async posts(limit: number, offset = 0) {
    const data = await this.call('wall.get', { domain: this.config.vkCommunity, count: limit, offset, filter: 'owner' });
    const result = z.object({ count: z.number(), items: z.array(vkPost) }).safeParse(data);
    if (!result.success) throw new SourceError('VK_POSTS_INVALID_RESPONSE');
    return { items: result.data.items.map(post => ({ id: `${post.owner_id}_${post.id}`, url: `https://vk.com/wall${post.owner_id}_${post.id}`,
      text: post.text, publishedAt: new Date(post.date * 1000).toISOString(), metrics: { likes: post.likes?.count, reposts: post.reposts?.count, views: post.views?.count, comments: post.comments?.count },
      attachments: post.attachments, pinned: Boolean(post.is_pinned) })), total: result.data.count,
      nextOffset: offset + result.data.items.length < result.data.count ? offset + result.data.items.length : null,
      sourceUrl: `https://vk.com/${this.config.vkCommunity}` };
  }
  overview() { return this.call('groups.getById', { group_ids: this.config.vkCommunity, fields: 'description,members_count,site,links,contacts,status' }); }
}

export async function syncSocial(config: Config, store: ContentStore, fetcher: typeof fetch = fetch) {
  try {
    const boosty = new BoostyApi(config, fetcher);
    const state = store.state('boosty'), offset = state?.cursor || undefined;
    const posts = await boosty.posts(50, offset);
    for (const post of posts.items) store.put({ source: 'boosty', externalId: post.id, url: post.url, title: post.title,
      text: post.text, publishedAt: post.publishedAt, metadata: { kind: 'post', access: post.access, paid: post.paid } });
    const cursor = posts.pagination.offset;
    store.status('boosty', null, cursor !== undefined && cursor !== null && posts.items.length ? String(cursor) : '');
  } catch (error) { store.status('boosty', error instanceof SourceError ? error.code : 'BOOSTY_POSTS_UNAVAILABLE'); }
  if (!config.vkToken) { store.status('vk', 'VK_TOKEN_NOT_CONFIGURED'); return; }
  try {
    const state = store.state('vk'), offset = Number(state?.cursor || 0);
    const posts = await new VkApi(config, fetcher).posts(100, Number.isSafeInteger(offset) ? offset : 0);
    for (const post of posts.items) store.put({ source: 'vk', externalId: post.id, url: post.url,
      title: post.text.split('\n')[0]?.slice(0, 200) || post.id, text: post.text, publishedAt: post.publishedAt,
      metadata: { kind: 'post', access: 'full', metrics: post.metrics, attachments: post.attachments, pinned: post.pinned } });
    store.status('vk', null, String(posts.nextOffset ?? 0));
  } catch (error) { store.status('vk', error instanceof SourceError ? error.code : 'VK_POSTS_UNAVAILABLE'); }
}
