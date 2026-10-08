import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { digest } from '../src/auth/oauth.js';
import { browserCredential } from '../src/auth/hearthpulse.js';
import { jsonResponse, profile, testConfig } from './helpers.js';

function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const db = openDatabase(':memory:');
  let identity: unknown = profile, unavailable = false, now = Date.now();
  const calls: RequestInit[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(init ?? {});
    if (unavailable) throw new Error('private token should never appear in the response');
    return jsonResponse(identity);
  };
  const runtime = createApp(testConfig(overrides), db, fetcher, () => now);
  return { ...runtime, db, calls, identity: (value: unknown) => { identity = value; }, unavailable: () => { unavailable = true; }, advance: (ms: number) => { now += ms; } };
}

async function begin(f: ReturnType<typeof fixture>, name = '<img src=x onerror=alert(1)>') {
  const registration = await request(f.app).post('/mcp/oauth/register').send({ client_name: name, redirect_uris: ['https://client.example/callback'] }).expect(201);
  const verifier = 'v'.repeat(43), clientId = registration.body.client_id as string;
  const query = { client_id: clientId, redirect_uri: 'https://client.example/callback', response_type: 'code',
    code_challenge: digest(verifier), code_challenge_method: 'S256', resource: 'http://localhost/mcp', scope: 'mcp.read', state: 'a&b' };
  return { clientId, verifier, query };
}

async function authorize(f: ReturnType<typeof fixture>) {
  const b = await begin(f);
  const consent = await request(f.app).get('/mcp/oauth/authorize').query(b.query).set('Cookie', 'manacost_auth_token=session-secret').expect(200);
  assert.ok(consent.text.includes('&lt;img'));
  assert.ok(!consent.text.includes('<img src=x'));
  const pending = /name="pending" value="([^"]+)"/.exec(consent.text)![1]!;
  const cookie = (consent.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  const approved = await request(f.app).post('/mcp/oauth/consent').set('Origin', 'http://localhost')
    .set('Cookie', `${cookie}; manacost_auth_token=session-secret`).type('form').send({ pending, decision: 'approve' }).expect(302);
  const callback = new URL(approved.headers.location!);
  assert.equal(callback.searchParams.get('state'), 'a&b');
  assert.equal(callback.searchParams.get('iss'), 'http://localhost/mcp');
  const exchange = { grant_type: 'authorization_code', client_id: b.clientId, code: callback.searchParams.get('code'),
    code_verifier: b.verifier, redirect_uri: b.query.redirect_uri, resource: b.query.resource };
  return { ...b, exchange, cookie, pending };
}

test('anonymous authorization links to the HearthPulse query-based login route and preserves continuation', async () => {
  const f = fixture({ HEARTHPULSE_LOGIN_URL: 'http://localhost/?login' });
  try {
    const b = await begin(f);
    const page = await request(f.app).get('/mcp/oauth/authorize').query(b.query).expect(401);
    assert.ok(page.text.includes('href="http://localhost/?login"'));
    assert.ok(!page.text.includes('/profile/'));
    assert.match(page.text, /href="\/mcp\/oauth\/authorize\?/);
    assert.match(page.text, /Продолжить после входа/);
  } finally { f.db.close(); }
});

test('anonymous, non-admin and unavailable identities cannot authorize or reach MCP', async () => {
  const f = fixture();
  try {
    const b = await begin(f);
    await request(f.app).get('/mcp/oauth/authorize').query(b.query).expect(401);
    const unauthorized = await request(f.app).post('/mcp').send({}).expect(401);
    assert.match(unauthorized.headers['www-authenticate']!, /oauth-protected-resource\/mcp/);
    f.identity({ user: { id: 'ordinary' }, adminAllowed: false });
    await request(f.app).get('/mcp/oauth/authorize').query(b.query).set('Cookie', 'manacost_auth_token=session').expect(403);
    f.unavailable();
    const response = await request(f.app).get('/mcp/oauth/authorize').query(b.query).set('Cookie', 'manacost_auth_token=session').expect(503);
    assert.ok(!response.text.includes('private token'));
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM oauth_codes').get() as { n: number }).n, 0);
  } finally { f.db.close(); }
});

test('OAuth PKCE binds code to client, redirect and resource; secrets are hashed/encrypted at rest', async () => {
  const f = fixture();
  try {
    const a = await authorize(f);
    await request(f.app).post('/mcp/oauth/token').type('form').send({ ...a.exchange, code_verifier: 'x'.repeat(43) }).expect(400);
    await request(f.app).post('/mcp/oauth/token').type('form').send({ ...a.exchange, resource: 'http://localhost/other' }).expect(400);
    await request(f.app).post('/mcp/oauth/token').type('form').send({ ...a.exchange, redirect_uri: 'https://evil.example/callback' }).expect(400);
    const tokens = await request(f.app).post('/mcp/oauth/token').type('form').send(a.exchange).expect(200);
    const authenticated = await f.oauth.authenticate(tokens.body.access_token);
    assert.equal(authenticated.extra?.userId, 'admin-1');
    const stored = JSON.stringify(['oauth_codes', 'oauth_grants', 'oauth_tokens'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all()));
    assert.ok(!stored.includes('session-secret'));
    assert.ok(!stored.includes(tokens.body.access_token));
    assert.ok(!stored.includes(tokens.body.refresh_token));
    assert.ok(f.calls.every(init => init.redirect === 'error'));
    assert.ok(f.calls.every(init => (init.headers as Record<string, string>).Cookie === 'manacost_auth_token=session-secret'));
    await request(f.app).post('/mcp/oauth/token').type('form').send(a.exchange).expect(400);
    await assert.rejects(f.oauth.authenticate(tokens.body.access_token));
  } finally { f.db.close(); }
});

test('role removal, logout, expiration and identity failures immediately stop access', async () => {
  const f = fixture();
  try {
    const a = await authorize(f), tokens = await request(f.app).post('/mcp/oauth/token').type('form').send(a.exchange).expect(200);
    const access = tokens.body.access_token as string;
    f.identity({ user: { id: 'admin-1' }, adminAllowed: false });
    await request(f.app).post('/mcp').auth(access, { type: 'bearer' }).send({}).expect(403);
    f.identity({ user: null, adminAllowed: false });
    await request(f.app).post('/mcp').auth(access, { type: 'bearer' }).send({}).expect(401);
    f.identity(profile); f.unavailable();
    await request(f.app).post('/mcp').auth(access, { type: 'bearer' }).send({}).expect(503);
    f.advance(601_000);
    await assert.rejects(f.oauth.authenticate(access));
  } finally { f.db.close(); }
});

test('refresh rotates, invalidates previous access and revokes the family on replay', async () => {
  const f = fixture();
  try {
    const a = await authorize(f), first = await request(f.app).post('/mcp/oauth/token').type('form').send(a.exchange).expect(200);
    const refresh = { grant_type: 'refresh_token', client_id: a.clientId, refresh_token: first.body.refresh_token, resource: a.query.resource };
    const next = await request(f.app).post('/mcp/oauth/token').type('form').send(refresh).expect(200);
    await assert.rejects(f.oauth.authenticate(first.body.access_token));
    await f.oauth.authenticate(next.body.access_token);
    await request(f.app).post('/mcp/oauth/token').type('form').send(refresh).expect(400);
    await assert.rejects(f.oauth.authenticate(next.body.access_token));
  } finally { f.db.close(); }
});

test('concurrent refresh reuse issues at most one response and revokes that family', async () => {
  const f = fixture();
  try {
    const a = await authorize(f), first = await request(f.app).post('/mcp/oauth/token').type('form').send(a.exchange).expect(200);
    const payload = { grant_type: 'refresh_token', client_id: a.clientId, refresh_token: first.body.refresh_token, resource: a.query.resource };
    const results = await Promise.all([request(f.app).post('/mcp/oauth/token').type('form').send(payload), request(f.app).post('/mcp/oauth/token').type('form').send(payload)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    const issued = results.find(r => r.status === 200)!;
    await assert.rejects(f.oauth.authenticate(issued.body.access_token));
  } finally { f.db.close(); }
});

test('consent rejects cross-site forms, missing binding cookie and replay', async () => {
  const f = fixture();
  try {
    const a = await authorize(f);
    await request(f.app).post('/mcp/oauth/consent').set('Origin', 'https://evil.example').type('form').send({ pending: a.pending, decision: 'approve' }).expect(403);
    await request(f.app).post('/mcp/oauth/consent').set('Origin', 'http://localhost').set('Cookie', 'manacost_auth_token=session-secret')
      .type('form').send({ pending: a.pending, decision: 'approve' }).expect(403);
    await request(f.app).post('/mcp/oauth/consent').set('Origin', 'http://localhost').set('Cookie', `${a.cookie}; manacost_auth_token=session-secret`)
      .type('form').send({ pending: a.pending, decision: 'approve' }).expect(403);
  } finally { f.db.close(); }
});

test('registration rejects insecure redirects; discovery and revocation work', async () => {
  const f = fixture();
  try {
    await request(f.app).post('/mcp/oauth/register').send({ redirect_uris: ['http://evil.example/callback'] }).expect(400);
    await request(f.app).get('/.well-known/oauth-protected-resource/mcp').expect(200);
    const metadata = await request(f.app).get('/.well-known/oauth-authorization-server/mcp').expect(200);
    assert.deepEqual(metadata.body.code_challenge_methods_supported, ['S256']);
    const a = await authorize(f), tokens = await request(f.app).post('/mcp/oauth/token').type('form').send(a.exchange).expect(200);
    await request(f.app).post('/mcp/oauth/revoke').type('form').send({ client_id: a.clientId, token: tokens.body.refresh_token }).expect(200);
    await assert.rejects(f.oauth.authenticate(tokens.body.access_token));
    assert.equal(browserCredential('manacost_auth_token=a; manacost_auth_token=b'), null);
    assert.throws(() => testConfig({ PUBLIC_URL: 'https://mcp.other.example/mcp' }), /share the HearthPulse origin/);
  } finally { f.db.close(); }
});
