#!/usr/bin/env node
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function createReader(settings, execute) {
  const expected = Buffer.from(`Basic ${Buffer.from(`manacost-mcp:${settings.password}`).toString('base64')}`);
  let active = 0;
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'application/json');
    const authorization = Buffer.from(req.headers.authorization ?? '');
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      res.writeHead(401); res.end('{"code":"unauthorized"}'); return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.replace(/^\/wp-json/, '');
    if (req.method !== 'GET' || !/^\/wp-json\/wp\/v2\/(posts|pages|categories|tags)(\/[1-9]\d*)?$/.test(url.pathname)) {
      res.writeHead(405); res.end('{"code":"unsupported_read"}'); return;
    }
    const params = {};
    for (const [key, value] of url.searchParams) {
      if (['page', 'per_page'].includes(key) && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= (key === 'per_page' ? 100 : 100000)) params[key] = Number(value);
      else if (key === 'order' && ['asc', 'desc'].includes(value)) params[key] = value;
      else if (key === 'orderby' && ['id', 'date', 'modified', 'name'].includes(value)) params[key] = value;
      else if (key === 'context' && value === 'edit') params[key] = value;
      else if (key === 'status' && value === 'publish') params[key] = value;
      else { res.writeHead(400); res.end('{"code":"unsupported_query"}'); return; }
    }
    if (active >= 2) { res.writeHead(503); res.end('{"code":"reader_busy"}'); return; }
    active++;
    try {
      const data = await execute(route, params);
      // Forward only pagination metadata, never arbitrary WP headers/cookies.
      for (const key of ['X-WP-Total', 'X-WP-TotalPages']) {
        const value = data.headers?.[key]; if (/^\d+$/.test(String(value))) res.setHeader(key, String(value));
      }
      res.writeHead(Number.isInteger(data.status) ? data.status : 502);
      res.end(JSON.stringify(data.body));
    } catch { res.writeHead(502); res.end('{"code":"wordpress_reader_unavailable"}'); }
    finally { active--; }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const password = process.env.WORDPRESS_READER_PASSWORD;
  const root = process.env.WORDPRESS_ROOT;
  if (!password || password.length < 32 || !root?.startsWith('/')) throw new Error('Private WordPress reader configuration missing');
  const execute = promisify(execFile);
  const script = join(dirname(fileURLToPath(import.meta.url)), 'wordpress-reader.php');
  const server = createReader({ password }, async (route, params) => {
    const result = await execute('/usr/local/bin/wp', [`--path=${root}`, '--url=https://kolodahearthstone.com', 'eval-file', script, route, JSON.stringify(params)], {
      timeout: 14000, maxBuffer: 8_000_000, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    return JSON.parse(result.stdout);
  });
  server.listen(3110, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
}
