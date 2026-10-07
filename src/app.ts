import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { Config } from './config.js';
import type { Db } from './database.js';
import { ContentStore } from './content/store.js';
import { HearthPulseIdentity, AccessDenied } from './auth/hearthpulse.js';
import { OAuthService } from './auth/oauth.js';
import { createToolServer } from './tools.js';
import { telegramRouter } from './sources/telegram.js';

export function createApp(config: Config, db: Db, fetcher: typeof fetch = fetch, now = Date.now) {
  const app = express(), store = new ContentStore(db);
  const oauth = new OAuthService(db, config, new HearthPulseIdentity(config.identityUrl, fetcher), now);
  const origin = new URL(config.publicUrl).origin;
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource${config.basePath}`;
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(hostHeaderValidation([new URL(config.publicUrl).hostname, 'localhost', '127.0.0.1', '[::1]']));
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"] } }, referrerPolicy: { policy: 'no-referrer' } }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.get(`${config.basePath}/health`, (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
  app.get(`/.well-known/oauth-protected-resource${config.basePath}`, (_req, res) => res.json({ resource: config.publicUrl,
    authorization_servers: [config.publicUrl], scopes_supported: ['mcp.read'], bearer_methods_supported: ['header'], resource_name: 'Manacost MCP' }));
  app.get(`/.well-known/oauth-authorization-server${config.basePath}`, (_req, res) => res.json(oauth.metadata()));
  // OIDC-style append discovery is also accepted by some OAuth clients.
  app.get(`${config.basePath}/.well-known/oauth-authorization-server`, (_req, res) => res.json(oauth.metadata()));
  app.use(`${config.basePath}/oauth`, rateLimit({ windowMs: 15 * 60_000, limit: 200, standardHeaders: 'draft-8', legacyHeaders: false }), oauth.router());
  app.use(`${config.basePath}/ingest/telegram`, rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }), telegramRouter(store, config));
  app.all(config.basePath || '/mcp', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const header = req.headers.authorization;
    const token = typeof header === 'string' && /^Bearer /i.test(header) ? header.slice(7) : '';
    try { req.auth = await oauth.authenticate(token); }
    catch (error) {
      const status = error instanceof AccessDenied ? error.status : 503;
      if (status === 401) res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp.read"`);
      return res.status(status).json({ error: status === 401 ? 'invalid_token' : status === 403 ? 'admin_required' : 'identity_unavailable' });
    }
    const requestOrigin = req.headers.origin;
    if (requestOrigin && requestOrigin !== origin) return res.status(403).json({ error: 'origin_not_allowed' });
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' });
    const server = createToolServer(config, store, fetcher);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500;
    res.status(status >= 400 && status < 500 ? status : 500).json({ error: status === 413 ? 'request_too_large' : status >= 400 && status < 500 ? 'invalid_request' : 'internal_error' });
  };
  app.use(errorHandler);
  return { app, oauth, store };
}
