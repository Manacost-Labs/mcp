import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createReader } from '../deploy/wordpress-reader.mjs';

test('private WordPress reader requires its credential and rejects writes, arbitrary routes and queries', async () => {
  const password = randomBytes(32).toString('hex');
  const calls = [];
  const server = createReader({ password }, async (route, params) => {
    calls.push({ route, params });
    return { status: 200, headers: { 'X-WP-TotalPages': 2, 'Set-Cookie': 'must-not-leak' }, body: [{ content: { raw: 'Paid body' } }] };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Basic ${Buffer.from(`manacost-mcp:${password}`).toString('base64')}` };
  try {
    assert.equal((await fetch(base + '/wp-json/wp/v2/posts')).status, 401);
    assert.equal((await fetch(base + '/wp-json/wp/v2/posts', { headers, method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/wp-json/wp/v2/users', { headers })).status, 405);
    assert.equal((await fetch(base + '/wp-json/wp/v2/posts?status=draft', { headers })).status, 400);
    assert.equal((await fetch(base + '/wp-json/wp/v2/posts?per_page=10000', { headers })).status, 400);
    assert.equal(calls.length, 0);
    const result = await fetch(base + '/wp-json/wp/v2/posts?context=edit&per_page=100&page=2', { headers });
    assert.equal(result.status, 200); assert.equal(result.headers.get('X-WP-TotalPages'), '2');
    assert.equal(result.headers.get('Set-Cookie'), null);
    assert.equal((await result.json())[0].content.raw, 'Paid body');
    assert.deepEqual(calls, [{ route: '/wp/v2/posts', params: { context: 'edit', per_page: 100, page: 2 } }]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
