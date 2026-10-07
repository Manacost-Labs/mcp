import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KolodaApi, graphValue, pageSchema } from '../src/sources/koloda.js';
import { BoostyApi, VkApi } from '../src/sources/social.js';
import { fetchBounded } from '../src/http.js';
import { jsonResponse, testConfig } from './helpers.js';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { loadConfig } from '../src/config.js';

test('environment template starts after filling the required encryption key', () => {
  const env = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
  const config = loadConfig({ ...env, SESSION_ENCRYPTION_KEY: '1'.repeat(64) });
  assert.equal(config.identityUrl, 'https://hearthpulse.net');
  assert.equal(config.kolodaToken, '');
  assert.equal(config.channelIds.length, 0);
});

test('Koloda reads all permitted collection metadata and cursor pages with the server token', async () => {
  const operations: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.kolodahearthstone.com/v1/graphql');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer scoped-test-token');
    const { query } = JSON.parse(init!.body as string) as { query: string }; operations.push(query);
    return jsonResponse({ data: query.includes('collections(') ? { collections: { items: [{ collection: 'catalog.cards', columns: [{ name: 'name_ru' }] }], pageInfo: { hasNextPage: true, nextCursor: 'opaque:2' } } }
      : { records: { items: [{ name_ru: 'Рено' }], pageInfo: { hasNextPage: false, nextCursor: null } } } });
  };
  const api = new KolodaApi('https://api.kolodahearthstone.com', 'scoped-test-token', fetcher);
  await api.collections({ schemaName: 'catalog', limit: 50, offset: 0 });
  await api.records({ collection: 'catalog.cards', fields: ['name_ru'], filters: { collectible: true }, after: 'opaque:2', limit: 50, offset: 0 });
  assert.match(operations[1]!, /after:"opaque:2"/);
  assert.ok(operations.every(operation => operation.startsWith('query {')));
  await assert.rejects(new KolodaApi('https://api.kolodahearthstone.com').collections({ limit: 50, offset: 0 }), /TOKEN_NOT_CONFIGURED/);
  assert.equal(pageSchema.safeParse({ after: 'cursor', offset: 10 }).success, false);
});

test('GraphQL escaping prevents operation injection and recognizes HTTP-200 errors', async () => {
  assert.equal(graphValue('"} mutation { deleteAll }'), JSON.stringify('"} mutation { deleteAll }'));
  assert.throws(() => graphValue({ 'invalid) {': true }), /Invalid filter field/);
  assert.throws(() => graphValue(Infinity), /Invalid GraphQL/);
  const fetcher: typeof fetch = async () => jsonResponse({ data: { collections: null }, errors: [{ message: 'secret upstream details' }] });
  await assert.rejects(new KolodaApi('https://api.kolodahearthstone.com', 'test', fetcher).collections({ limit: 50, offset: 0 }), /KOLODA_GRAPHQL_ERROR/);
});

test('bounded source requests do not follow redirects and reject excessive response sizes', async () => {
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(init?.redirect, 'error'); return new Response('x'.repeat(100));
  };
  await assert.rejects(fetchBounded('https://kolodahearthstone.com', {}, fetcher, 50), /UPSTREAM_RESPONSE_TOO_LARGE/);
});

test('Boosty separates complete bodies and paid previews, and excludes buyer identities', async () => {
  const fetcher: typeof fetch = async url => {
    if (String(url).includes('api.boosty.to')) return jsonResponse({ data: [
      { id: 'public', title: 'Public post', isPaid: false, createdAt: 1700000000, data: [{ type: 'text', content: '<p>Full text</p>' }] },
      { id: 'paid', title: 'Paid post', isPaid: true, hasAccess: false, data: [{ type: 'text', content: 'Teaser' }] },
    ], extra: { offset: 'next' } });
    return jsonResponse({ summary: { postPurchases: 3 }, posts: [{ postId: 'paid', title: 'Paid post', purchases: 3 }], buyers: [{ email: 'private@example.com' }], transactions: [{ userId: 'private-id' }] });
  };
  const api = new BoostyApi(testConfig(), fetcher), posts = await api.posts(20);
  assert.equal(posts.items[0]?.access, 'full'); assert.equal(posts.items[1]?.access, 'excerpt');
  const sales = await api.analytics('post-sales');
  assert.ok(!JSON.stringify(sales).includes('private'));
  assert.equal((sales as { posts: unknown[] }).posts.length, 1);
});

test('VK uses only read methods, puts the token in the POST body and returns engagement counts', async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.vk.com/method/wall.get');
    const body = new URLSearchParams(init!.body as URLSearchParams);
    assert.equal(body.get('access_token'), 'private-test-token'); assert.equal(body.get('domain'), 'manacost');
    return jsonResponse({ response: { count: 1, items: [{ id: 42, owner_id: -123, date: 1700000000, text: 'Post', views: { count: 100 }, likes: { count: 10 } }] } });
  };
  const result = await new VkApi(testConfig({ VK_API_TOKEN: 'private-test-token' }), fetcher).posts(20);
  assert.equal(result.items[0]?.url, 'https://vk.com/wall-123_42'); assert.equal(result.items[0]?.metrics.views, 100);
  await assert.rejects(new VkApi(testConfig(), fetcher).posts(20), /VK_TOKEN_NOT_CONFIGURED/);
});
