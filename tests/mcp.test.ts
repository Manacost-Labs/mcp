import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Express } from 'express';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { digest } from '../src/auth/oauth.js';
import { jsonResponse, profile, testConfig } from './helpers.js';

test('official MCP client completes HTTP handshake, lists read-only tools and reads paid content', async () => {
  let app: Express;
  const listener = createServer((req, res) => app(req, res));
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, resource = `${origin}/mcp`;
  const db = openDatabase(':memory:');
  const config = testConfig({ PUBLIC_URL: resource, HEARTHPULSE_URL: origin, HEARTHPULSE_LOGIN_URL: `${origin}/profile/`,
    PLAUSIBLE_SITE_IDS: 'hs-manacost.ru', PLAUSIBLE_API_KEY: 'fixture-statistics-key' });
  const runtime = createApp(config, db, async (url, init) => String(url).endsWith('/api/v2/query')
    ? jsonResponse({ results: [{ metrics: [25, 50], dimensions: [] }], meta: { total_rows: 1 }, query: JSON.parse(init!.body as string) })
    : jsonResponse(profile)); app = runtime.app;
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    const contentId = runtime.store.put({ source: 'koloda', externalId: 'paid-42', url: 'https://kolodahearthstone.com/paid/',
      title: 'Paid guide', text: 'Full paid body', metadata: { access: 'full', paid: true, kind: 'article',
        page: { navigation: Array.from({ length: 30 }, (_, i) => ({ text: `Section ${i}`, url: `https://kolodahearthstone.com/section-${i}/` })) } } });
    const registration = await request(app).post('/mcp/oauth/register').send({ redirect_uris: ['https://client.example/callback'] }).expect(201);
    const verifier = 'a'.repeat(43), clientId = registration.body.client_id as string;
    const consent = await request(app).get('/mcp/oauth/authorize').query({ client_id: clientId, redirect_uri: 'https://client.example/callback',
      response_type: 'code', code_challenge: digest(verifier), code_challenge_method: 'S256', resource }).set('Cookie', 'manacost_auth_token=test-session').expect(200);
    const pending = /name="pending" value="([^"]+)"/.exec(consent.text)![1]!;
    const cookie = (consent.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const approved = await request(app).post('/mcp/oauth/consent').set('Origin', origin).set('Cookie', `${cookie}; manacost_auth_token=test-session`)
      .type('form').send({ pending, decision: 'approve' }).expect(302);
    const code = new URL(approved.headers.location!).searchParams.get('code');
    const tokens = await request(app).post('/mcp/oauth/token').type('form').send({ grant_type: 'authorization_code', client_id: clientId,
      code, code_verifier: verifier, redirect_uri: 'https://client.example/callback', resource }).expect(200);
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } } }));
    const tools = await client.listTools();
    for (const name of ['get_content', 'read_records', 'get_site_overview', 'list_boosty_posts', 'list_vk_posts', 'list_plausible_sites', 'get_plausible_stats']) {
      assert.ok(tools.tools.some(tool => tool.name === name), `Missing tool: ${name}`);
    }
    assert.ok(tools.tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
    const result = await client.callTool({ name: 'get_content', arguments: { id: contentId } });
    const content = result.content as { type: string; text: string }[];
    assert.match(content[0]!.text, /Full paid body/);
    assert.match(content[0]!.text, /"access":"full"/);
    const navigation = await client.callTool({ name: 'get_content_metadata', arguments: { id: contentId, section: 'navigation', limit: 10, offset: 10 } });
    const metadata = JSON.parse((navigation.content as { text: string }[])[0]!.text) as { data: { items: { text: string }[]; nextOffset: number } };
    assert.equal(metadata.data.items.length, 10); assert.equal(metadata.data.items[0]?.text, 'Section 10'); assert.equal(metadata.data.nextOffset, 20);
    const traffic = await client.callTool({ name: 'get_plausible_stats', arguments: { siteId: 'hs-manacost.ru' } });
    assert.ok(!traffic.isError);
    const trafficData = JSON.parse((traffic.content as { text: string }[])[0]!.text).data;
    assert.deepEqual(trafficData.results[0].metrics, [25, 50]);
    assert.equal(runtime.store.state('plausible')?.error, null);
    const denied = await client.callTool({ name: 'get_plausible_stats', arguments: { siteId: 'other.example' } });
    assert.equal(denied.isError, true);
    assert.match((denied.content as { text: string }[])[0]!.text, /PLAUSIBLE_SITE_NOT_ALLOWED/);
    const status = await client.callTool({ name: 'get_source_status', arguments: {} });
    assert.ok(!(status as { isError?: boolean }).isError);
  } finally {
    await client.close();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    db.close();
  }
});
