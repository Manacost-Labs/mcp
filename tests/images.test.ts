import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleImages, imageMetadataPreview, fetchArticleImage } from '../src/content/images.js';
import { testConfig } from './helpers.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

test('metadata previews bound image arrays without mutating the complete stored list', () => {
  const metadata = { images: Array.from({ length: 100 }, (_, index) => ({ index, url: `https://kolodahearthstone.com/${index}.png` })),
    page: { images: Array.from({ length: 30 }, () => ({ url: 'https://kolodahearthstone.com/public.png' })) } };
  const preview = imageMetadataPreview(metadata, 20);
  assert.equal((preview.images as unknown[]).length, 20);
  assert.equal(preview.imagesTotal, 100);
  assert.equal(preview.imagesNextOffset, 20);
  assert.equal(((preview.page as Record<string, unknown>).images as unknown[]).length, 20);
  assert.equal(metadata.images.length, 100);
  assert.equal(metadata.page.images.length, 30);
});

test('full article images take precedence over public page teasers', () => {
  const images = articleImages({ images: [{ url: 'https://kolodahearthstone.com/paid.png' }],
    page: { images: [{ url: 'https://kolodahearthstone.com/teaser.png' }] } });
  assert.equal(images[0]!.url, 'https://kolodahearthstone.com/paid.png');
  assert.equal(images[0]!.index, 0);
  assert.deepEqual(articleImages({ images: [], page: { images: [{ url: 'https://kolodahearthstone.com/logo.png' }] } }), []);
});

test('image fetch returns binary PNG, bounds reads and never forwards credentials', async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://kolodahearthstone.com/paid.png');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    assert.equal(new Headers(init?.headers).get('cookie'), null);
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  };
  const image = await fetchArticleImage('http://kolodahearthstone.com/paid.png', testConfig(), fetcher);
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.data, png.toString('base64'));
  await assert.rejects(fetchArticleImage('https://kolodahearthstone.com/paid.png', testConfig(), fetcher, 10), /IMAGE_TOO_LARGE/);
});

test('image fetch rejects external and internal targets, ports and unsafe schemes before any request', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(png); };
  for (const url of ['http://127.0.0.1/private.png', 'https://kolodahearthstone.com.evil.example/image.png',
    'https://user:secret@kolodahearthstone.com/image.png', 'https://kolodahearthstone.com:8443/image.png',
    'file:///etc/passwd', 'data:image/png;base64,aGVsbG8=', 'https://169.254.169.254/image.png']) {
    await assert.rejects(fetchArticleImage(url, testConfig(), fetcher), /IMAGE_URL_NOT_ALLOWED/);
  }
  assert.equal(calls, 0);
});

test('redirects are revalidated; HTML, SVG, MIME mismatches and oversized streams are rejected', async () => {
  let calls = 0;
  const redirect: typeof fetch = async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }); };
  await assert.rejects(fetchArticleImage('https://kolodahearthstone.com/image.png', testConfig(), redirect), /IMAGE_URL_NOT_ALLOWED/);
  assert.equal(calls, 1);
  for (const [body, mime] of [['<html>private</html>', 'text/html'], ['<svg><script>bad</script></svg>', 'image/svg+xml'], [png, 'image/jpeg']] as const) {
    const fetcher: typeof fetch = async () => new Response(body, { headers: { 'Content-Type': mime } });
    await assert.rejects(fetchArticleImage('https://kolodahearthstone.com/image.png', testConfig(), fetcher), /IMAGE_TYPE_UNSUPPORTED/);
  }
  const stream: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(png); controller.close(); } }));
  await assert.rejects(fetchArticleImage('https://kolodahearthstone.com/image.png', testConfig(), stream, 10), /IMAGE_TOO_LARGE/);
});

test('safe redirects work and redirect loops stop at a fixed limit', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async url => {
    calls++;
    return String(url).endsWith('/old.png') ? new Response(null, { status: 301, headers: { Location: '/new.png' } })
      : new Response(png, { headers: { 'Content-Type': 'image/png' } });
  };
  const image = await fetchArticleImage('https://kolodahearthstone.com/old.png', testConfig(), fetcher);
  assert.equal(image.url, 'https://kolodahearthstone.com/new.png');
  assert.equal(calls, 2);
  const loop: typeof fetch = async () => new Response(null, { status: 302, headers: { Location: '/old.png' } });
  await assert.rejects(fetchArticleImage('https://kolodahearthstone.com/old.png', testConfig(), loop), /IMAGE_REDIRECT_LIMIT/);
});

test('additional CDN hosts require an exact configured hostname', async () => {
  const fetcher: typeof fetch = async () => new Response(png, { headers: { 'Content-Type': 'image/png' } });
  await assert.rejects(fetchArticleImage('https://images.example.com/deck.png', testConfig(), fetcher), /IMAGE_URL_NOT_ALLOWED/);
  assert.equal((await fetchArticleImage('https://images.example.com/deck.png', testConfig({ ARTICLE_IMAGE_HOSTS: 'images.example.com' }), fetcher)).mimeType, 'image/png');
  for (const host of ['*.example.com', '127.0.0.1', 'https://images.example.com', 'images.example.com:443']) {
    assert.throws(() => testConfig({ ARTICLE_IMAGE_HOSTS: host }), /ARTICLE_IMAGE_HOSTS/);
  }
});
