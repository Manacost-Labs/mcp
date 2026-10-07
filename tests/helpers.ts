import { loadConfig } from '../src/config.js';

export function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({ PUBLIC_URL: 'http://localhost/mcp', HEARTHPULSE_URL: 'http://localhost',
    HEARTHPULSE_LOGIN_URL: 'http://localhost/profile/', SESSION_ENCRYPTION_KEY: 'a'.repeat(64),
    DATABASE_PATH: ':memory:', ...overrides });
}
export const jsonResponse = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
export const profile = { user: { id: 'admin-1' }, adminAllowed: true };
