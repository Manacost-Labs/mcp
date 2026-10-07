import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { ContentStore } from '../src/content/store.js';
import { wordPressBody, htmlText, extractPage } from '../src/content/extract.js';
import { WebsiteIngestor, sameSiteUrl } from '../src/sources/websites.js';
import { telegramRouter, storeTelegramUpdate } from '../src/sources/telegram.js';
import { jsonResponse, testConfig } from './helpers.js';
import express from 'express';
import request from 'supertest';

test('both Koloda VIP formats expose full paid text without unlock codes', async () => {
  const raw = '<p>Public teaser.</p>[vip_locker code="SECRET_UNLOCK"]<p>Paid tactics one.</p>[/vip_locker]\n' +
    '<!-- wp:svl/locker {"code":"SECOND_SECRET","content":"<p>Paid tactics two.</p>"} /-->';
  const decoded = htmlText(wordPressBody(raw));
  assert.match(decoded, /Paid tactics one/); assert.match(decoded, /Paid tactics two/);
  assert.ok(!decoded.includes('SECRET'));
  const db = openDatabase(':memory:'), store = new ContentStore(db), config = testConfig({ KOLODA_WP_USERNAME: 'integration', KOLODA_WP_PASSWORD: 'test-password' });
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://kolodahearthstone.com/wp-json/wp/v2/posts/42?context=edit');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('integration:test-password').toString('base64')}`);
    assert.equal(init?.redirect, 'error');
    return jsonResponse({ id: 42, link: 'https://kolodahearthstone.com/paid-guide/', title: { rendered: 'Paid guide' }, content: { rendered: 'Subscribe!', raw } });
  };
  try {
    const id = await new WebsiteIngestor(store, config, fetcher).getWordPressContent(config.websites.find(s => s.id === 'koloda')!, 'posts', 42);
    const item = store.get(id)!;
    assert.equal(item.metadata.access, 'full'); assert.equal(item.metadata.paid, true);
    assert.match(item.text, /Paid tactics two/);
    assert.equal(store.search({ query: 'tactics', paid: true, limit: 20, offset: 0 }).total, 1);
  } finally { db.close(); }
});

test('paid on-demand retrieval fails explicitly without source credentials or raw body', async () => {
  const db = openDatabase(':memory:'), store = new ContentStore(db), config = testConfig();
  try {
    const site = config.websites.find(s => s.id === 'koloda')!;
    await assert.rejects(new WebsiteIngestor(store, config).getWordPressContent(site, 'posts', 42), /FULL_CONTENT_CREDENTIALS_REQUIRED/);
    const fetcher: typeof fetch = async () => jsonResponse({ id: 42, link: site.baseUrl, title: { rendered: 'Paid' }, content: { rendered: 'Subscribe!' } });
    await assert.rejects(new WebsiteIngestor(store, config, fetcher).getWordPressContent({ ...site, username: 'test', password: 'test' }, 'posts', 42), /WORDPRESS_RAW_CONTENT_MISSING/);
  } finally { db.close(); }
});

test('marketing extraction preserves navigation, metadata, headings, images and structured data', () => {
  const page = extractPage('<html><head><title>Manacost</title><meta name="description" content="Hearthstone guides"><link rel="canonical" href="/guides/"><script type="application/ld+json">{"@type":"Organization"}</script></head><body><nav><a href="/pricing/">Subscription</a></nav><main><h1>Guides</h1><p>Article body.</p><img src="/cover.webp" alt="Deck"><script>BAD_SCRIPT</script></main></body></html>', 'https://kolodahearthstone.com/guides/');
  assert.equal(page.metadata.description, 'Hearthstone guides');
  assert.equal(page.metadata.navigation[0]?.url, 'https://kolodahearthstone.com/pricing/');
  assert.equal(page.metadata.images[0]?.alt, 'Deck');
  assert.equal(page.metadata.structuredData.length, 1);
  assert.ok(!page.text.includes('BAD_SCRIPT'));
  assert.equal(sameSiteUrl('https://evil.example/path', 'https://kolodahearthstone.com'), null);
  assert.equal(sameSiteUrl('/wp-admin/', 'https://kolodahearthstone.com'), null);
});

test('content updates replace the FTS entry and long texts remain fully readable in chunks', () => {
  const db = openDatabase(':memory:'), store = new ContentStore(db);
  try {
    const item = { source: 'koloda' as const, externalId: '42', url: 'https://kolodahearthstone.com/a/', title: 'Маг', text: 'Старая колода', metadata: { access: 'full' } };
    const id = store.put(item);
    assert.equal(store.search({ query: 'старая', limit: 10, offset: 0 }).total, 1);
    const text = 'Новая колода\n' + 'x'.repeat(33000);
    store.put({ ...item, text });
    assert.equal(store.search({ query: 'старая', limit: 10, offset: 0 }).total, 0);
    assert.equal(store.search({ query: '" OR * (колода)', limit: 10, offset: 0 }).total, 0);
    const chunks = [store.get(id, 0)!, store.get(id, 16000)!, store.get(id, 32000)!];
    assert.equal(chunks.map(c => c.text).join(''), text); assert.equal(chunks[2]?.nextOffset, null);
  } finally { db.close(); }
});

test('Telegram forwarder enforces a secret and channel allowlist, handles edits and deduplicates', async () => {
  const config = testConfig({ TELEGRAM_CHANNEL_IDS: '-100123', TELEGRAM_INGEST_SECRET: 's'.repeat(32) });
  const db = openDatabase(':memory:'), store = new ContentStore(db), app = express();
  app.use(express.json()); app.use('/telegram', telegramRouter(store, config));
  const post = { message_id: 10, date: 1700000000, chat: { id: -100123, type: 'channel', username: 'manacost_ru' }, text: 'Original post' };
  const update = { update_id: 1, channel_post: post };
  try {
    await request(app).post('/telegram').send(update).expect(401);
    await request(app).post('/telegram').set('X-Manacost-Ingest-Secret', config.telegramSecret!).send(update).expect(200);
    assert.deepEqual(storeTelegramUpdate(store, update, config.channelIds), { duplicate: true });
    storeTelegramUpdate(store, { update_id: 2, edited_channel_post: { ...post, edit_date: 1700000010, text: 'Edited post' } }, config.channelIds);
    storeTelegramUpdate(store, { update_id: 3, channel_post: post }, config.channelIds);
    const result = store.search({ source: 'telegram', limit: 10, offset: 0 });
    assert.equal(result.total, 1); assert.equal(result.items[0]?.text, 'Edited post');
    assert.deepEqual(storeTelegramUpdate(store, { update_id: 4, channel_post: { ...post, chat: { ...post.chat, id: -100999 } } }, config.channelIds), { ignored: true });
  } finally { db.close(); }
});
