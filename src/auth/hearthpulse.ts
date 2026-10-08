import { z } from 'zod';
import { fetchJson, SourceError } from '../http.js';

const profileSchema = z.object({ user: z.object({ id: z.union([z.string(), z.number()]) }).nullable(), adminAllowed: z.boolean() });
const secureCookie = '__Host-manacost_auth_token';
const legacyCookie = 'manacost_auth_token';
const validValue = (value: string) => /^[A-Za-z0-9%._~-]{1,4096}$/.test(value);
export class AccessDenied extends Error {
  constructor(public readonly status: 401 | 403) { super(status === 401 ? 'LOGIN_REQUIRED' : 'ADMIN_REQUIRED'); }
}

export class HearthPulseIdentity {
  constructor(private baseUrl: string, private fetcher: typeof fetch = fetch) {}
  async check(credential: string): Promise<string> {
    // Keep old grants (raw legacy tokens) compatible; new grants preserve the secure cookie name.
    const secure = credential.startsWith(`${secureCookie}=`);
    const value = secure ? credential.slice(secureCookie.length + 1) : credential;
    if (!validValue(value)) throw new AccessDenied(401);
    const { data } = await fetchJson(`${this.baseUrl}/api/auth/me`, {
      headers: { Cookie: `${secure ? secureCookie : legacyCookie}=${value}`, Accept: 'application/json' },
    }, this.fetcher);
    const profile = profileSchema.safeParse(data);
    if (!profile.success) throw new SourceError('IDENTITY_INVALID_RESPONSE');
    if (!profile.data.user) throw new AccessDenied(401);
    if (!profile.data.adminAllowed) throw new AccessDenied(403);
    return String(profile.data.user.id);
  }
}

export function browserCredential(cookie: string | undefined): string | null {
  const { name, found } = selectedCookies(cookie);
  if (found.length !== 1) return null;
  const value = found[0]!.slice(name.length + 1);
  if (!validValue(value)) return null;
  return name === secureCookie ? `${name}=${value}` : value;
}

function selectedCookies(cookie: string | undefined) {
  const parts = (cookie ?? '').split(';').map(part => part.trim());
  const secure = parts.filter(part => part.startsWith(`${secureCookie}=`));
  // Even an empty/malformed secure cookie blocks fallback, matching HearthPulse's primary-cookie policy.
  return secure.length ? { name: secureCookie, found: secure }
    : { name: legacyCookie, found: parts.filter(part => part.startsWith(`${legacyCookie}=`)) };
}

export function browserCredentialFailure(cookie: string | undefined) {
  const { found } = selectedCookies(cookie);
  return found.length === 0 ? 'missing_cookie' : found.length > 1 ? 'duplicate_cookie' : 'invalid_cookie';
}
