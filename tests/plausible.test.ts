import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlausibleApi, plausibleQuerySchema } from '../src/sources/plausible.js';
import { loadConfig } from '../src/config.js';
import { jsonResponse, testConfig } from './helpers.js';

const config = () => testConfig({ PLAUSIBLE_API_KEY: 'stats-only-fixture', PLAUSIBLE_SITE_IDS: 'hs-manacost.ru,hearthpulse.net' });

test('Plausible queries only its fixed Stats endpoint, preserves warnings and paginates labelled aggregates', async () => {
  const api = new PlausibleApi(config(), async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:8000/api/v2/query');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer stats-only-fixture');
    assert.ok(!String(url).includes('fixture'));
    const query = JSON.parse(init!.body as string);
    assert.deepEqual(query.filters, [['is', 'visit:utm_campaign', ['launch']]]);
    assert.deepEqual(query.pagination, { limit: 1, offset: 0 });
    assert.deepEqual(query.include, { total_rows: true, imports: true });
    assert.deepEqual(query.date_range, ['2026-10-01', '2026-10-07']);
    return jsonResponse({ results: [{ metrics: [12], dimensions: ['/guide'] }],
      query, meta: { total_rows: 2, imports_included: false, imports_warning: 'Not compatible with this filter' } });
  });
  const result = await api.query({ siteId: 'hs-manacost.ru', metrics: ['visitors'], dimensions: ['event:page'], limit: 1,
    dateRange: ['2026-10-01', '2026-10-07'], includeImports: true, filters: [['is', 'visit:utm_campaign', ['launch']]] });
  assert.deepEqual(result.metrics, ['visitors']); assert.deepEqual(result.dimensions, ['event:page']);
  assert.equal(result.nextOffset, 1); assert.equal(result.meta.imports_included, false);
  assert.match(JSON.stringify(result.meta), /Not compatible/);
  assert.ok(!JSON.stringify(api.sites()).includes('stats-only-fixture'));
});

test('Plausible rejects unconfigured keys, disallowed sites and invalid/broad queries before any request', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('Should never request'); };
  await assert.rejects(new PlausibleApi(testConfig(), fetcher).query({ siteId: 'hs-manacost.ru' }), /PLAUSIBLE_NOT_CONFIGURED/);
  const api = new PlausibleApi(config(), fetcher);
  await assert.rejects(api.query({ siteId: 'https://attacker.example/' }), /PLAUSIBLE_SITE_NOT_ALLOWED/);
  for (const input of [{ limit: 101 }, { dimensions: ['event:props:email'] }, { dateRange: ['2026-10-07', '2026-10-01'] },
    { dateRange: ['2020-01-01', '2026-10-01'] }, { filters: [['is', 'time:day', ['2026-10-01']]] },
    { metrics: ['visitors', 'visitors'] }, { orderBy: [['events', 'desc']] }, { endpoint: '/api/event' }]) {
    assert.equal(plausibleQuerySchema.safeParse({ siteId: 'hs-manacost.ru', ...input }).success, false);
  }
  assert.equal(calls, 0);
  assert.throws(() => loadConfig({ ...process.env, SESSION_ENCRYPTION_KEY: 'a'.repeat(64), PLAUSIBLE_URL: 'http://attacker.example' }), /HTTPS/);
  assert.throws(() => testConfig({ PLAUSIBLE_API_KEY: 'key\nInjected-Header: value' }), /PLAUSIBLE_API_KEY/);
});

test('Plausible distinguishes empty data from errors and rejects malformed aggregate responses', async () => {
  const empty = await new PlausibleApi(config(), async (_url, init) => jsonResponse({ results: [], meta: { total_rows: 0 }, query: JSON.parse(init!.body as string) }))
    .query({ siteId: 'hearthpulse.net', dimensions: ['event:goal'] });
  assert.deepEqual(empty.results, []); assert.equal(empty.nextOffset, null);
  for (const payload of [{ results: [{ metrics: [1], dimensions: [] }], meta: {}, query: {} },
    { results: [{ metrics: [1, 2], dimensions: ['extra'] }], meta: {}, query: {} }, { error: 'secret internal failure' }]) {
    await assert.rejects(new PlausibleApi(config(), async () => jsonResponse(payload)).query({ siteId: 'hs-manacost.ru' }), /PLAUSIBLE_INVALID_RESPONSE/);
  }
  await assert.rejects(new PlausibleApi(config(), async () => jsonResponse({ error: 'secret details' }, 400)).query({ siteId: 'hs-manacost.ru' }), /PLAUSIBLE_QUERY_REJECTED/);
  await assert.rejects(new PlausibleApi(config(), async () => jsonResponse({}, 401)).query({ siteId: 'hs-manacost.ru' }), /UPSTREAM_HTTP_401/);
});
