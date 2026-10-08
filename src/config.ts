import { z } from 'zod';

export const sourceIds = ['manacost', 'koloda', 'old-koloda', 'hearthpulse', 'telegram', 'boosty', 'vk'] as const;
export type SourceId = typeof sourceIds[number];
export type Website = { id: 'manacost' | 'koloda' | 'old-koloda' | 'hearthpulse'; baseUrl: string; apiUrl?: string; username?: string; password?: string };

const envSchema = z.object({
  PUBLIC_URL: z.url().default('https://hearthpulse.net/mcp'),
  HEARTHPULSE_URL: z.url().default('https://hearthpulse.net'),
  HEARTHPULSE_LOGIN_URL: z.url().default('https://hearthpulse.net/?login'),
  HEARTHPULSE_INTERNAL_URL: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  DATABASE_PATH: z.string().default('./data/mcp.sqlite'),
  SESSION_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  KOLODA_URL: z.url().default('https://api.kolodahearthstone.com'),
  KOLODA_API_TOKEN: z.string().optional(),
  KOLODA_WP_API_URL: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
  OLD_KOLODA_DATABASE_PATH: z.string().optional(),
  HEARTHPULSE_API_KEY: z.string().optional(),
  TELEGRAM_INGEST_SECRET: z.string().optional(),
  TELEGRAM_CHANNEL_IDS: z.string().default(''),
  TELEGRAM_PUBLIC_CHANNELS: z.string().default(''),
  INGEST_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
  WP_PAGES_PER_SYNC: z.coerce.number().int().min(1).max(1000).default(10),
  HTML_PAGES_PER_SYNC: z.coerce.number().int().min(1).max(1000).default(20),
  BOOSTY_LOCAL_URL: z.url().default('http://127.0.0.1:18082'),
  BOOSTY_API_URL: z.url().default('https://api.boosty.to'),
  BOOSTY_BLOG: z.string().regex(/^[A-Za-z0-9_-]+$/).default('kolodahearthstone'),
  BOOSTY_CONTENT_TOKEN: z.string().optional(),
  BOOSTY_CONTENT_TOKEN_FILE: z.string().optional(),
  VK_COMMUNITY: z.string().regex(/^[A-Za-z0-9_]+$/).default('manacost'),
  VK_API_TOKEN: z.string().optional(),
  VK_API_VERSION: z.string().regex(/^\d+\.\d+$/).default('5.199'),
  PLAUSIBLE_URL: z.url().default('http://127.0.0.1:8000'),
  PLAUSIBLE_DASHBOARD_URL: z.url().default('https://stats.hs-manacost.ru'),
  PLAUSIBLE_API_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).regex(/^[^\r\n]+$/).optional()),
  PLAUSIBLE_SITE_IDS: z.string().default(''),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const e = parsed.data;
  const publicUrl = new URL(e.PUBLIC_URL);
  const hearthpulseUrl = new URL(e.HEARTHPULSE_URL);
  const loginUrl = new URL(e.HEARTHPULSE_LOGIN_URL);
  const urls = [publicUrl, hearthpulseUrl, loginUrl, new URL(e.KOLODA_URL), new URL(e.BOOSTY_LOCAL_URL), new URL(e.BOOSTY_API_URL)];
  if (e.HEARTHPULSE_INTERNAL_URL) urls.push(new URL(e.HEARTHPULSE_INTERNAL_URL));
  if (e.KOLODA_WP_API_URL) urls.push(new URL(e.KOLODA_WP_API_URL));
  urls.push(new URL(e.PLAUSIBLE_URL), new URL(e.PLAUSIBLE_DASHBOARD_URL));
  for (const url of urls) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || (url.search && url !== loginUrl) || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
      throw new Error('Configured URLs must use HTTPS (HTTP is allowed only on loopback), contain no credentials or fragment; only the login URL may contain a query');
    }
  }
  if (publicUrl.origin !== hearthpulseUrl.origin || loginUrl.origin !== hearthpulseUrl.origin) {
    throw new Error('MCP authorization must share the HearthPulse origin to use its existing host-only login cookie');
  }
  const channelIds = e.TELEGRAM_CHANNEL_IDS.split(',').map(s => s.trim()).filter(Boolean);
  const publicChannels = e.TELEGRAM_PUBLIC_CHANNELS.split(',').map(s => s.trim()).filter(Boolean);
  const plausibleSiteIds = [...new Set(e.PLAUSIBLE_SITE_IDS.split(',').map(s => s.trim()).filter(Boolean))];
  if (plausibleSiteIds.length > 50 || plausibleSiteIds.some(site => site.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(site))) {
    throw new Error('PLAUSIBLE_SITE_IDS must contain only configured site domains');
  }
  if (publicChannels.some(channel => !/^[A-Za-z0-9_]{5,32}$/.test(channel))) throw new Error('Invalid Telegram public channel username');
  if (e.BOOSTY_CONTENT_TOKEN_FILE && !e.BOOSTY_CONTENT_TOKEN_FILE.startsWith('/')) throw new Error('Boosty token file must use an absolute path');
  if (e.OLD_KOLODA_DATABASE_PATH && !e.OLD_KOLODA_DATABASE_PATH.startsWith('/')) throw new Error('Legacy archive must use an absolute path');
  if (channelIds.some(id => !/^-100\d+$/.test(id))) throw new Error('TELEGRAM_CHANNEL_IDS must contain numeric channel IDs');
  if (channelIds.length && (!e.TELEGRAM_INGEST_SECRET || e.TELEGRAM_INGEST_SECRET.length < 32)) {
    throw new Error('Configured Telegram channels require an ingest secret of at least 32 characters');
  }
  const websites: Website[] = [
    { id: 'manacost', baseUrl: 'https://hs-manacost.ru', username: env.MANACOST_WP_USERNAME, password: env.MANACOST_WP_PASSWORD },
    { id: 'koloda', baseUrl: 'https://kolodahearthstone.com', apiUrl: e.KOLODA_WP_API_URL, username: env.KOLODA_WP_USERNAME, password: env.KOLODA_WP_PASSWORD },
    { id: 'old-koloda', baseUrl: 'https://old.kolodahearthstone.ru', username: env.OLD_KOLODA_WP_USERNAME, password: env.OLD_KOLODA_WP_PASSWORD },
    { id: 'hearthpulse', baseUrl: hearthpulseUrl.origin },
  ];
  return {
    publicUrl: publicUrl.href.replace(/\/$/, ''), basePath: publicUrl.pathname.replace(/\/$/, ''),
    hearthpulseUrl: hearthpulseUrl.origin, loginUrl: e.HEARTHPULSE_LOGIN_URL,
    identityUrl: (e.HEARTHPULSE_INTERNAL_URL ?? hearthpulseUrl.origin).replace(/\/$/, ''),
    host: e.HOST, port: e.PORT, databasePath: e.DATABASE_PATH, encryptionKey: e.SESSION_ENCRYPTION_KEY,
    kolodaUrl: e.KOLODA_URL.replace(/\/$/, ''), kolodaToken: e.KOLODA_API_TOKEN, legacyDatabasePath: e.OLD_KOLODA_DATABASE_PATH,
    hearthpulseApiKey: e.HEARTHPULSE_API_KEY, websites, channelIds,
    telegramSecret: e.TELEGRAM_INGEST_SECRET, publicChannels, ingestInterval: e.INGEST_INTERVAL_SECONDS * 1000,
    wpPagesPerSync: e.WP_PAGES_PER_SYNC,
    htmlPagesPerSync: e.HTML_PAGES_PER_SYNC,
    boostyLocalUrl: e.BOOSTY_LOCAL_URL.replace(/\/$/, ''), boostyApiUrl: e.BOOSTY_API_URL.replace(/\/$/, ''), boostyBlog: e.BOOSTY_BLOG, boostyContentToken: e.BOOSTY_CONTENT_TOKEN, boostyTokenFile: e.BOOSTY_CONTENT_TOKEN_FILE,
    vkCommunity: e.VK_COMMUNITY, vkToken: e.VK_API_TOKEN, vkVersion: e.VK_API_VERSION,
    plausibleUrl: e.PLAUSIBLE_URL.replace(/\/$/, ''), plausibleDashboardUrl: e.PLAUSIBLE_DASHBOARD_URL.replace(/\/$/, ''),
    plausibleApiKey: e.PLAUSIBLE_API_KEY, plausibleSiteIds,
  };
}
export type Config = ReturnType<typeof loadConfig>;
