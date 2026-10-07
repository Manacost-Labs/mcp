export class SourceError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Redirects are disabled so source credentials cannot be forwarded to another host. */
export async function fetchBounded(url: string | URL, init: RequestInit = {}, fetcher: typeof fetch = fetch, maxBytes = 8_000_000) {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new SourceError(`UPSTREAM_HTTP_${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new SourceError('UPSTREAM_RESPONSE_TOO_LARGE');
  if (!response.body) throw new SourceError('UPSTREAM_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SourceError('UPSTREAM_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { text: Buffer.concat(chunks).toString('utf8'), headers: response.headers };
}

export async function fetchJson(url: string | URL, init: RequestInit = {}, fetcher: typeof fetch = fetch) {
  const result = await fetchBounded(url, init, fetcher);
  try { return { data: JSON.parse(result.text) as unknown, headers: result.headers }; }
  catch { throw new SourceError('UPSTREAM_INVALID_JSON'); }
}
