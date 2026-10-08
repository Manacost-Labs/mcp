import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { Db } from '../database.js';
import { AccessDenied, browserCredential, browserCredentialFailure, HearthPulseIdentity } from './hearthpulse.js';

const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Client = { client_id: string; client_name: string; redirect_uris: string[]; token_endpoint_auth_method: 'none'; grant_types: string[]; response_types: string[] };
type Authorization = { clientId: string; redirectUri: string; challenge: string; resource: string; state?: string };
type Grant = { id: string; client_id: string; user_id: string; credential: string; resource: string; revoked: number };
type StoredToken = Grant & { expires_at: number; consumed: number };
type Code = { data: string; expires_at: number; consumed: number; grant_id: string | null };

const redirectSchema = z.string().max(2048).refine(raw => {
  try {
    const url = new URL(raw);
    return !url.username && !url.password && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}, 'Redirect URI must be HTTPS or loopback HTTP');
const registrationSchema = z.object({
  client_name: z.string().min(1).max(100).default('MCP client'),
  redirect_uris: z.array(redirectSchema).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).min(1).default(['code']),
});
const authorizationSchema = z.object({
  client_id: z.string().max(100), redirect_uri: z.string().max(2048), response_type: z.literal('code'),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'),
  resource: z.string().max(2048), scope: z.literal('mcp.read').default('mcp.read'), state: z.string().max(2048).optional(),
});
const consentSchema = z.object({ pending: z.string().regex(/^[A-Za-z0-9_-]{43}$/), decision: z.enum(['approve', 'deny']) });

export class OAuthService {
  constructor(private db: Db, private config: Config, private identity: HearthPulseIdentity, private now = Date.now) {}

  private seal(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(this.config.encryptionKey, 'hex'), iv, { authTagLength: 16 });
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }

  private unseal(value: string) {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length < 29) throw new AccessDenied(401);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.config.encryptionKey, 'hex'), bytes.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  }

  private client(id: string): Client | null {
    const row = this.db.prepare('SELECT data FROM oauth_clients WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Client : null;
  }

  private tokens(grantId: string) {
    const access = randomToken(), refresh = randomToken();
    const insert = this.db.prepare('INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES(?,?,?,?)');
    insert.run(digest(access), grantId, 'access', this.now() + 600_000);
    insert.run(digest(refresh), grantId, 'refresh', this.now() + 7 * 86400_000);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 600, scope: 'mcp.read' };
  }

  private async checkGrant(grant: Grant) {
    if (grant.revoked) throw new AccessDenied(401);
    const userId = await this.identity.check(this.unseal(grant.credential));
    if (userId !== grant.user_id) throw new AccessDenied(401);
  }

  async authenticate(token: string): Promise<AuthInfo> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AccessDenied(401);
    const grant = this.db.prepare(`SELECT g.*,t.expires_at,t.consumed FROM oauth_tokens t
      JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=? AND t.kind='access'`).get(digest(token)) as StoredToken | undefined;
    if (!grant || grant.expires_at <= this.now() || grant.revoked || grant.resource !== this.config.publicUrl) throw new AccessDenied(401);
    await this.checkGrant(grant);
    return { token, clientId: grant.client_id, scopes: ['mcp.read'], expiresAt: Math.floor(grant.expires_at / 1000),
      resource: new URL(grant.resource), extra: { userId: grant.user_id } };
  }

  metadata() {
    const url = this.config.publicUrl;
    return { issuer: url, authorization_endpoint: `${url}/oauth/authorize`, token_endpoint: `${url}/oauth/token`,
      registration_endpoint: `${url}/oauth/register`, revocation_endpoint: `${url}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp.read'], authorization_response_iss_parameter_supported: true };
  }

  cleanup() {
    this.db.transaction(() => {
      for (const table of ['oauth_pending', 'oauth_codes', 'oauth_tokens']) this.db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(this.now());
      this.db.prepare(`DELETE FROM oauth_grants WHERE NOT EXISTS(SELECT 1 FROM oauth_tokens WHERE grant_id=oauth_grants.id)
        AND NOT EXISTS(SELECT 1 FROM oauth_codes WHERE grant_id=oauth_grants.id)`).run();
      this.db.prepare('DELETE FROM telegram_updates WHERE received_at < ?').run(this.now() - 7 * 86400_000);
    })();
  }

  router() {
    const router = Router();
    const consentCookie = this.config.publicUrl.startsWith('https:') ? '__Secure-manacost_mcp_consent' : 'manacost_mcp_consent';
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next(); });

    router.post('/register', (req, res) => {
      const input = registrationSchema.safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'invalid_client_metadata' });
      const count = this.db.prepare('SELECT count(*) AS count FROM oauth_clients').get() as { count: number };
      if (count.count >= 10_000) return res.status(503).json({ error: 'temporarily_unavailable' });
      const client: Client = { ...input.data, client_id: randomToken() };
      this.db.prepare('INSERT INTO oauth_clients(id,data,created_at) VALUES(?,?,?)').run(client.client_id, JSON.stringify(client), this.now());
      return res.status(201).json({ ...client, client_id_issued_at: Math.floor(this.now() / 1000) });
    });

    router.get('/authorize', async (req, res) => {
      const input = authorizationSchema.safeParse(req.query);
      if (!input.success) return res.status(400).send('Invalid authorization request. PKCE S256 and the MCP resource are required.');
      const p = input.data, client = this.client(p.client_id);
      if (!client || !client.redirect_uris.includes(p.redirect_uri) || p.resource !== this.config.publicUrl) return res.status(400).send('Invalid client, redirect URI or resource.');
      const credential = browserCredential(req.headers.cookie);
      if (!credential) return this.loginPage(req, res);
      try { await this.identity.check(credential); }
      catch (error) {
        if (error instanceof AccessDenied && error.status === 401) return this.loginPage(req, res, 'session_not_recognized');
        return res.status(error instanceof AccessDenied ? 403 : 503).send(error instanceof AccessDenied ? 'Доступ к MCP разрешён только администраторам HearthPulse.' : 'Проверка HearthPulse временно недоступна.');
      }
      const pending = randomToken(), csrf = randomToken();
      const params: Authorization = { clientId: client.client_id, redirectUri: p.redirect_uri, challenge: p.code_challenge, resource: p.resource, state: p.state };
      this.db.prepare('INSERT INTO oauth_pending(hash,csrf_hash,data,expires_at) VALUES(?,?,?,?)')
        .run(digest(pending), digest(csrf), JSON.stringify(params), this.now() + 600_000);
      res.cookie(consentCookie, csrf, { httpOnly: true, secure: this.config.publicUrl.startsWith('https:'), sameSite: 'lax',
        path: `${this.config.basePath}/oauth`, maxAge: 600_000 });
      // Client name, redirect and configured path are escaped; pending is random base64url. CSP prohibits scripts.
      return res.type('html').send(this.page('Подключение Manacost MCP', `<p>Приложение <strong>${escapeHtml(client.client_name)}</strong> запрашивает доступ для чтения материалов сайтов, Telegram, Boosty, VK и базы Koloda.</p>
        <p>Адрес возврата: <code>${escapeHtml(p.redirect_uri) /* nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- escaped attribute/text; covered by malicious-client regression test */}</code></p>
        <form method="post" action="${escapeHtml(this.config.basePath)}/oauth/consent"><input type="hidden" name="pending" value="${pending}">
        <button name="decision" value="approve">Разрешить чтение</button> <button name="decision" value="deny">Отказать</button></form>`));
    });

    router.post('/consent', async (req, res) => {
      if (req.headers.origin !== new URL(this.config.publicUrl).origin) return res.status(403).send('Invalid origin');
      const input = consentSchema.safeParse(req.body);
      if (!input.success) return res.status(400).send('Invalid consent request');
      const pending = this.db.prepare('SELECT * FROM oauth_pending WHERE hash=?').get(digest(input.data.pending)) as
        { hash: string; csrf_hash: string; data: string; expires_at: number } | undefined;
      const cookies = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${consentCookie}=`));
      const csrf = cookies.length === 1 ? cookies[0]!.slice(consentCookie.length + 1) : '';
      if (!pending || pending.expires_at <= this.now() || !equal(digest(csrf), pending.csrf_hash)) return res.status(403).send('Expired or invalid consent');
      const credential = browserCredential(req.headers.cookie);
      if (!credential) return res.status(401).send('Sign in again');
      let userId: string;
      try { userId = await this.identity.check(credential); }
      catch (error) { return res.status(error instanceof AccessDenied ? error.status : 503).send('Administrator verification failed'); }
      const p = JSON.parse(pending.data) as Authorization;
      const target = new URL(p.redirectUri);
      if (p.state !== undefined) target.searchParams.set('state', p.state);
      target.searchParams.set('iss', this.config.publicUrl);
      this.db.transaction(() => {
        const consumed = this.db.prepare('DELETE FROM oauth_pending WHERE hash=?').run(pending.hash);
        if (!consumed.changes) throw new Error('Consent already consumed');
        if (input.data.decision === 'deny') { target.searchParams.set('error', 'access_denied'); return; }
        const code = randomToken();
        this.db.prepare('INSERT INTO oauth_codes(hash,data,expires_at) VALUES(?,?,?)').run(digest(code),
          JSON.stringify({ ...p, userId, credential: this.seal(credential) }), this.now() + 120_000);
        target.searchParams.set('code', code);
      })();
      res.clearCookie(consentCookie, { path: `${this.config.basePath}/oauth`, secure: this.config.publicUrl.startsWith('https:') });
      return res.redirect(302, target.href);
    });

    router.post('/token', async (req, res) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.client_id !== 'string' || !this.client(body.client_id)) return res.status(400).json({ error: 'invalid_client' });
      if (body.resource !== this.config.publicUrl) return res.status(400).json({ error: 'invalid_target' });
      if (body.scope !== undefined && body.scope !== 'mcp.read') return res.status(400).json({ error: 'invalid_scope' });
      let racedGrantId: string | undefined;
      try {
        if (body.grant_type === 'authorization_code') {
          if (typeof body.code !== 'string' || typeof body.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) return res.status(400).json({ error: 'invalid_grant' });
          const code = this.db.prepare('SELECT * FROM oauth_codes WHERE hash=?').get(digest(body.code)) as Code | undefined;
          if (!code || code.expires_at <= this.now()) return res.status(400).json({ error: 'invalid_grant' });
          const p = JSON.parse(code.data) as Authorization & { userId: string; credential: string };
          if (p.clientId !== body.client_id || p.redirectUri !== body.redirect_uri || p.resource !== body.resource || !equal(p.challenge, digest(body.code_verifier))) return res.status(400).json({ error: 'invalid_grant' });
          if (code.consumed) {
            if (code.grant_id) this.db.prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').run(code.grant_id);
            return res.status(400).json({ error: 'invalid_grant' });
          }
          if (await this.identity.check(this.unseal(p.credential)) !== p.userId) throw new AccessDenied(401);
          const result = this.db.transaction(() => {
            const id = randomToken();
            this.db.prepare('INSERT INTO oauth_grants(id,client_id,user_id,credential,resource) VALUES(?,?,?,?,?)').run(id, p.clientId, p.userId, p.credential, p.resource);
            const updated = this.db.prepare('UPDATE oauth_codes SET consumed=1,grant_id=? WHERE hash=? AND consumed=0').run(id, digest(body.code as string));
            if (!updated.changes) {
              racedGrantId = (this.db.prepare('SELECT grant_id FROM oauth_codes WHERE hash=?').get(digest(body.code as string)) as { grant_id: string } | undefined)?.grant_id;
              throw new AccessDenied(401);
            }
            return this.tokens(id);
          })();
          return res.json(result);
        }
        if (body.grant_type === 'refresh_token') {
          if (typeof body.refresh_token !== 'string') return res.status(400).json({ error: 'invalid_grant' });
          const hash = digest(body.refresh_token);
          const grant = this.db.prepare(`SELECT g.*,t.expires_at,t.consumed FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=? AND t.kind='refresh'`).get(hash) as StoredToken | undefined;
          if (!grant || grant.client_id !== body.client_id || grant.resource !== body.resource || grant.revoked || grant.expires_at <= this.now()) return res.status(400).json({ error: 'invalid_grant' });
          if (grant.consumed) {
            this.db.prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').run(grant.id);
            return res.status(400).json({ error: 'invalid_grant' });
          }
          await this.checkGrant(grant);
          const result = this.db.transaction(() => {
            const updated = this.db.prepare('UPDATE oauth_tokens SET consumed=1 WHERE hash=? AND consumed=0').run(hash);
            if (!updated.changes) { racedGrantId = grant.id; throw new AccessDenied(401); }
            this.db.prepare("DELETE FROM oauth_tokens WHERE grant_id=? AND kind='access'").run(grant.id);
            return this.tokens(grant.id);
          })();
          return res.json(result);
        }
        return res.status(400).json({ error: 'unsupported_grant_type' });
      } catch (error) {
        // Revoke outside the rolled-back transaction if two requests consumed the same credential.
        if (racedGrantId) this.db.prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').run(racedGrantId);
        return res.status(error instanceof AccessDenied ? 400 : 503).json({ error: error instanceof AccessDenied ? 'invalid_grant' : 'temporarily_unavailable' });
      }
    });

    router.post('/revoke', (req, res) => {
      if (typeof req.body?.token === 'string' && typeof req.body?.client_id === 'string') {
        this.db.prepare(`UPDATE oauth_grants SET revoked=1 WHERE client_id=? AND id IN(SELECT grant_id FROM oauth_tokens WHERE hash=?)`)
          .run(req.body.client_id, digest(req.body.token));
      }
      return res.json({});
    });
    return router;
  }

  private page(title: string, body: string) {
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
      <body><main><h1>${title}</h1>${body}</main></body></html>`;
  }
  private loginPage(req: Request, res: Response, reason?: string) {
    reason ??= browserCredentialFailure(req.headers.cookie);
    const diagnostic = randomToken().slice(0, 12);
    // Never log cookie values, identity IDs, OAuth parameters or the request URL.
    console.warn(JSON.stringify({ event: 'mcp_browser_login_required', reason, diagnostic }));
    const message = reason === 'missing_cookie'
      ? 'MCP не получил сессию HearthPulse из браузера. Вход и подключение MCP должны быть открыты в одном браузере и одном профиле.'
      : reason === 'duplicate_cookie'
        ? 'Браузер передал несколько cookies сессии HearthPulse. MCP не может однозначно выбрать сессию.'
        : reason === 'session_not_recognized'
          ? 'Cookie получена, но HearthPulse не подтвердил эту сессию. Продолжение входа пока невозможно.'
          : 'Браузер передал сессию HearthPulse в неподдерживаемом формате.';
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('html').send(this.page('Вход через HearthPulse', `<p>Войдите на HearthPulse под аккаунтом администратора, затем вернитесь к подключению MCP.</p>
      <p role="status">${message}</p><p>Код диагностики: <code>${diagnostic}</code></p>
      <p><a href="${escapeHtml(this.config.loginUrl)}" target="_blank" rel="noopener noreferrer">Войти на HearthPulse</a></p>
      <p><a href="${escapeHtml(req.originalUrl)}">Продолжить после входа</a></p>`));
  }
}
