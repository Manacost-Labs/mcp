import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from '../config.js';
import { fetchArticleImage } from '../content/images.js';
import { SourceError } from '../http.js';
import { KolodaApi } from '../sources/koloda.js';

export type CardReference = { cardId: string; source: 'card' | 'hero' | 'trinket' };
export type ResolvedCard = { name: string; image: Buffer; sourceUrl: string };
const record = z.object({ data: z.object({ card_id: z.string().max(100), name: z.object({ ru: z.string().max(200), en: z.string().max(200).optional() }),
  images: z.record(z.string(), z.string().max(4096).nullable()) }) });
const endpoints = { card: 'cards', hero: 'heroes', trinket: 'trinkets' };
const originalImageHosts = ['hearthstone.wiki.gg', 'art.hearthstonejson.com'];

/** IDs resolve through the existing catalog. Callers never supply image URLs or credentials. */
export async function resolveBuilderCards(cards: CardReference[], config: Config, fetcher: typeof fetch) {
  const catalog = new KolodaApi(config.bgCatalogUrl, undefined, fetcher);
  const imageConfig = { ...config, articleImageHosts: [...config.articleImageHosts, ...originalImageHosts, new URL(config.bgCatalogUrl).hostname] };
  const result = new Map<string, ResolvedCard>();
  // Sequential fetching bounds the memory and load of a 100-card request; duplicates share a decode.
  for (const card of cards) {
    const key = `${card.source}:${card.cardId}`;
    if (result.has(key)) continue;
    let payload: unknown;
    const path = `/api/v1/${endpoints[card.source]}/${encodeURIComponent(card.cardId)}`;
    try { payload = await catalog.get(path); }
    catch (error) {
      if (error instanceof SourceError && error.code === 'UPSTREAM_HTTP_404') throw new SourceError(`CARD_NOT_FOUND:${card.cardId}`);
      throw error;
    }
    const parsed = record.safeParse(payload);
    if (!parsed.success || parsed.data.data.card_id !== card.cardId) throw new SourceError('CARD_RESPONSE_INVALID');
    const data = parsed.data.data;
    const url = card.source === 'hero' ? data.images.hero : data.images.card ?? data.images.framed;
    if (!url) throw new SourceError(`CARD_IMAGE_MISSING:${card.cardId}`);
    const picture = await fetchArticleImage(url, imageConfig, fetcher, 3 * 1024 * 1024);
    let image: Buffer;
    try { image = await sharp(Buffer.from(picture.data, 'base64'), { limitInputPixels: 16_000_000 })
      .resize({ width: 320, height: 460, fit: 'inside', withoutEnlargement: true }).png().toBuffer(); }
    catch { throw new SourceError(`CARD_IMAGE_DECODE_FAILED:${card.cardId}`); }
    result.set(key, { name: data.name.ru || data.name.en || card.cardId, image, sourceUrl: `${config.bgCatalogUrl}${path}` });
  }
  return result;
}
