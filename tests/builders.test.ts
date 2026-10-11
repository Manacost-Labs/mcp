import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { strategySchema, tierListSchema } from '../src/builders/contracts.js';
import { renderStrategy, renderTierList } from '../src/builders/render.js';
import { testConfig, jsonResponse } from './helpers.js';

const card = { key: 'core', cardId: 'BG_TEST', row: 1, column: 1 };

test('builder contracts reject overlapping slots, unknown links and unbounded canvases', () => {
  assert.equal(strategySchema.safeParse({ cards: [card, { ...card, key: 'other' }] }).success, false);
  assert.equal(strategySchema.safeParse({ rows: 1, cards: [{ ...card, row: 2 }] }).success, false);
  assert.equal(strategySchema.safeParse({ rows: 11, cards: [card] }).success, false);
  assert.equal(strategySchema.safeParse({ cards: [card], annotations: [{ type: 'arrow', from: 'core', to: 'missing' }] }).success, false);
  assert.equal(strategySchema.safeParse({ cards: [{ ...card, imageUrl: 'file:///etc/passwd' }] }).success, false);
  assert.equal(tierListSchema.safeParse({ tiers: [{ tier: 'S', cards: [{ cardId: 'BG_TEST' }] }, { tier: 'S', cards: [] }] }).success, false);
  assert.equal(tierListSchema.safeParse({ tiers: [{ tier: 'S', cards: [{ cardId: 'BG_TEST' }] }, { tier: 'A', cards: [{ cardId: 'BG_TEST' }] }] }).success, false);
});

test('both renderers return actual PNGs with the expected card count and row geometry', async () => {
  const png = await sharp({ create: { width: 40, height: 60, channels: 4, background: '#c07020' } }).png().toBuffer();
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(new URL(String(url)).origin, 'https://api.kolodahearthstone.com');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    if (String(url).includes('/uploads/')) {
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
    }
    return jsonResponse({ data: { card_id: 'BG_TEST', name: { ru: 'Настоящая карта' }, images: { card: 'https://api.kolodahearthstone.com/uploads/test.png' } } });
  };
  const gatewayConfig = testConfig({ KOLODA_URL: 'http://127.0.0.1:3120', KOLODA_API_TOKEN: 'fixture-private-gateway-token' });
  const one = await renderStrategy(strategySchema.parse({ cards: [card], title: '<Не HTML>' }), gatewayConfig, fetcher);
  const three = await renderStrategy(strategySchema.parse({ rows: 3, cards: [card] }), testConfig(), fetcher);
  assert.equal(one.cardCount, 1);
  assert.equal(one.mimeType, 'image/png');
  assert.equal((await sharp(one.buffer).metadata()).width, 1600);
  assert.ok(three.height > one.height * 2);
  const tiers = await renderTierList(tierListSchema.parse({ tiers: [{ tier: 'S', cards: [{ cardId: 'BG_TEST' }] }, { tier: 'D', cards: [] }] }), testConfig(), fetcher);
  assert.equal(tiers.cardCount, 1);
  assert.equal((await sharp(tiers.buffer).metadata()).format, 'png');
});

test('missing cards or unsafe upstream image URLs fail before rendering any partial image', async () => {
  const input = strategySchema.parse({ cards: [card] });
  await assert.rejects(renderStrategy(input, testConfig(), async () => jsonResponse({ error: 'missing' }, 404)), /CARD_NOT_FOUND/);
  let calls = 0;
  await assert.rejects(renderStrategy(input, testConfig(), async () => {
    calls++;
    return jsonResponse({ data: { card_id: 'BG_TEST', name: { ru: 'Карта' }, images: { card: 'http://127.0.0.1/private.png' } } });
  }), /IMAGE_URL_NOT_ALLOWED/);
  assert.equal(calls, 1);
});
