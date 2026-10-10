import { isIP } from 'node:net';
import type { Config } from '../config.js';
import { SourceError } from '../http.js';

export function imageMetadataPreview(metadata: Record<string, unknown>, limit: number) {
  const trim = (value: Record<string, unknown>): Record<string, unknown> => Array.isArray(value.images)
    ? { ...value, images: value.images.slice(0, limit), imagesTotal: value.images.length,
      imagesNextOffset: value.images.length > limit ? limit : null } : { ...value };
  const result = trim(metadata);
  if (metadata.page && typeof metadata.page === 'object') result.page = trim(metadata.page as Record<string, unknown>);
  return result;
}

export function articleImages(metadata: Record<string, unknown>): Record<string, unknown>[] {
  const page = metadata.page && typeof metadata.page === 'object' ? metadata.page as Record<string, unknown> : {};
  const images = Array.isArray(metadata.images) ? metadata.images : Array.isArray(page.images) ? page.images : [];
  return images.filter(image => image && typeof image === 'object' && typeof image.url === 'string')
    .map((image, index) => ({ ...image, index }));
}

function allowedImageUrl(raw: string, config: Config) {
  const hosts = new Set([...config.articleImageHosts, ...config.websites.flatMap(site => {
    const host = new URL(site.baseUrl).hostname;
    return [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`];
  })]);
  let url: URL;
  try { url = new URL(raw); } catch { throw new SourceError('IMAGE_URL_NOT_ALLOWED'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || raw.length > 4096 ||
    isIP(url.hostname) || !url.hostname.includes('.') || !hosts.has(url.hostname)) throw new SourceError('IMAGE_URL_NOT_ALLOWED');
  url.protocol = 'https:';
  url.hash = '';
  return url;
}

function imageMime(data: Buffer) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new SourceError('IMAGE_TYPE_UNSUPPORTED');
}

/** Only indexed illustrations on owned/configured hosts are fetched. No source credentials. */
export async function fetchArticleImage(raw: string, config: Config, fetcher: typeof fetch = fetch, maxBytes = 5 * 1024 * 1024) {
  let url = allowedImageUrl(raw, config);
  const signal = AbortSignal.timeout(15_000);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetcher(url, { redirect: 'manual', signal, headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (hop === 3) throw new SourceError('IMAGE_REDIRECT_LIMIT');
      const location = response.headers.get('location');
      if (!location) throw new SourceError('IMAGE_URL_NOT_ALLOWED');
      url = allowedImageUrl(new URL(location, url).href, config);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new SourceError(`IMAGE_HTTP_${response.status}`); }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel(); throw new SourceError('IMAGE_TOO_LARGE');
    }
    if (!response.body) throw new SourceError('IMAGE_EMPTY_RESPONSE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new SourceError('IMAGE_TOO_LARGE');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const buffer = Buffer.concat(chunks), mimeType = imageMime(buffer);
    const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (declared && declared !== 'application/octet-stream' && declared !== mimeType) throw new SourceError('IMAGE_TYPE_UNSUPPORTED');
    return { url: url.href, mimeType, data: buffer.toString('base64'), bytes: buffer.length };
  }
  throw new SourceError('IMAGE_REDIRECT_LIMIT');
}
