import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ContentStore } from '../content/store.js';
import type { Config } from '../config.js';

const postSchema = z.object({ message_id: z.number().int(), date: z.number().int(), edit_date: z.number().int().optional(),
  chat: z.object({ id: z.number().int(), type: z.literal('channel'), username: z.string().regex(/^[A-Za-z0-9_]+$/).optional(), title: z.string().optional() }),
  text: z.string().max(100000).optional(), caption: z.string().max(100000).optional(), entities: z.array(z.unknown()).optional(),
  caption_entities: z.array(z.unknown()).optional(), photo: z.array(z.unknown()).optional(), video: z.unknown().optional(), document: z.unknown().optional(), media_group_id: z.string().optional() });
const updateSchema = z.object({ update_id: z.number().int(), channel_post: postSchema.optional(), edited_channel_post: postSchema.optional() });

export function storeTelegramUpdate(store: ContentStore, input: unknown, channelIds: string[]) {
  const update = updateSchema.parse(input), post = update.edited_channel_post ?? update.channel_post;
  if (!post || !channelIds.includes(String(post.chat.id))) return { ignored: true };
  return store.db.transaction(() => {
    const inserted = store.db.prepare('INSERT OR IGNORE INTO telegram_updates(id,received_at) VALUES(?,?)').run(update.update_id, Date.now());
    if (!inserted.changes) return { duplicate: true };
    const externalId = `${post.chat.id}:${post.message_id}`;
    const old = store.db.prepare('SELECT updated_at FROM content WHERE source=? AND external_id=?').get('telegram', externalId) as { updated_at: string } | undefined;
    const updatedAt = new Date((post.edit_date ?? post.date) * 1000).toISOString();
    if (old && old.updated_at > updatedAt) return { ignored: true };
    const text = post.text ?? post.caption ?? '';
    const channelPath = post.chat.username ?? `c/${String(post.chat.id).replace(/^-100/, '')}`;
    const id = store.put({ source: 'telegram', externalId, url: `https://t.me/${channelPath}/${post.message_id}`,
      title: text.split('\n')[0]?.slice(0, 200) || `${post.chat.title ?? 'Telegram'} #${post.message_id}`,
      text, publishedAt: new Date(post.date * 1000).toISOString(), updatedAt,
      metadata: { kind: 'post', access: 'full', channelId: String(post.chat.id), channelTitle: post.chat.title,
        entities: post.entities ?? post.caption_entities, photos: post.photo, video: post.video, document: post.document, mediaGroupId: post.media_group_id } });
    store.status('telegram', null);
    return { id };
  })();
}

export function telegramRouter(store: ContentStore, config: Config) {
  const router = Router();
  router.post('/', (req, res) => {
    const secret = config.telegramSecret;
    const provided = req.headers['x-manacost-ingest-secret'];
    if (!secret || !config.channelIds.length) return res.status(503).json({ error: 'TELEGRAM_NOT_CONFIGURED' });
    if (typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(secret) || !timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) {
      return res.status(401).json({ error: 'INVALID_INGEST_SECRET' });
    }
    try { return res.json(storeTelegramUpdate(store, req.body, config.channelIds)); }
    catch { return res.status(400).json({ error: 'INVALID_TELEGRAM_UPDATE' }); }
  });
  return router;
}
