import { z } from 'zod';
import { fetchJson, SourceError } from '../http.js';

const profileSchema = z.object({ user: z.object({ id: z.union([z.string(), z.number()]) }).nullable(), adminAllowed: z.boolean() });
export class AccessDenied extends Error {
  constructor(public readonly status: 401 | 403) { super(status === 401 ? 'LOGIN_REQUIRED' : 'ADMIN_REQUIRED'); }
}

export class HearthPulseIdentity {
  constructor(private baseUrl: string, private fetcher: typeof fetch = fetch) {}
  async check(credential: string): Promise<string> {
    if (!/^[A-Za-z0-9%._~-]{1,4096}$/.test(credential)) throw new AccessDenied(401);
    const { data } = await fetchJson(`${this.baseUrl}/api/auth/me`, {
      headers: { Cookie: `manacost_auth_token=${credential}`, Accept: 'application/json' },
    }, this.fetcher);
    const profile = profileSchema.safeParse(data);
    if (!profile.success) throw new SourceError('IDENTITY_INVALID_RESPONSE');
    if (!profile.data.user) throw new AccessDenied(401);
    if (!profile.data.adminAllowed) throw new AccessDenied(403);
    return String(profile.data.user.id);
  }
}

export function browserCredential(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const found = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith('manacost_auth_token='));
  if (found.length !== 1) return null;
  const credential = found[0]!.slice('manacost_auth_token='.length);
  return /^[A-Za-z0-9%._~-]{1,4096}$/.test(credential) ? credential : null;
}
