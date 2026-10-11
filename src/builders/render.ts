import sharp, { type OverlayOptions } from 'sharp';
import type { Config } from '../config.js';
import { SourceError } from '../http.js';
import type { StrategyInput, TierListInput } from './contracts.js';
import { resolveBuilderCards, type CardReference, type ResolvedCard } from './cards.js';

const WIDTH = 1600, TOP = 156, GAP = 18;
const INK = '#30251c', PAPER = '#f7e8bf', PANEL = '#ead6a7', ACCENT = '#7b251e';
let activeRenders = 0;
type Box = { x: number; y: number; width: number; height: number };
type Tile = CardReference & { note?: string; highlighted: boolean; box: Box; key: string };
export type BuilderImage = { buffer: Buffer; mimeType: 'image/png'; width: number; height: number; cardCount: number; sourceUrls: string[] };
const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);

function text(value: string, x: number, y: number, width: number, size = 20, color = INK, lines = 2) {
  const max = Math.max(4, Math.floor(width / (size * 0.62)));
  const parts: string[] = [];
  const words = value.replace(/\s+/g, ' ').trim().split(' ');
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > max) { parts.push(line); line = ''; }
    let remainder = word;
    while (remainder.length > max) { if (line) { parts.push(line); line = ''; } parts.push(remainder.slice(0, max)); remainder = remainder.slice(max); }
    line = line ? `${line} ${remainder}` : remainder;
  }
  if (line) parts.push(line);
  const visible = parts.slice(0, lines);
  if (parts.length > lines) visible[lines - 1] = `${visible[lines - 1]?.slice(0, max - 1)}…`;
  return visible.map((part, index) => `<text x="${x}" y="${y + index * (size + 5)}" font-family="DejaVu Sans,sans-serif" font-size="${size}" fill="${color}">${escape(part)}</text>`).join('');
}

function svg(body: string, height: number) { return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">${body}</svg>`); }
function background(title: string, height: number) {
  return `<rect width="${WIDTH}" height="${height}" fill="${PAPER}"/><rect x="12" y="12" width="1576" height="${height - 24}" fill="none" stroke="#b89a69" stroke-width="3"/><rect x="24" y="24" width="1552" height="112" fill="${ACCENT}"/>` + text(title, 48, 73, 1450, 40, PAPER) + text('HearthPulse · Поля сражений', 48, height - 23, 1400, 16);
}

async function tileLayers(tiles: Tile[], cards: Map<string, ResolvedCard>) {
  const layers: OverlayOptions[] = [];
  let labels = '';
  for (const tile of tiles) {
    const card = cards.get(`${tile.source}:${tile.cardId}`);
    if (!card) throw new SourceError('CARD_NOT_FOUND');
    const image = await sharp(card.image).resize({ width: tile.box.width, height: tile.box.height - 108, fit: 'contain', background: '#00000000' }).png().toBuffer();
    layers.push({ input: image, left: tile.box.x, top: tile.box.y });
    labels += text(card.name, tile.box.x, tile.box.y + tile.box.height - 82, tile.box.width, 18);
    if (tile.note) labels += text(tile.note, tile.box.x, tile.box.y + tile.box.height - 34, tile.box.width, 16, ACCENT);
    if (tile.highlighted) labels += `<rect x="${tile.box.x - 3}" y="${tile.box.y - 3}" width="${tile.box.width + 6}" height="${tile.box.height - 102}" rx="8" fill="none" stroke="#9a6823" stroke-width="5"/>`;
  }
  return { layers, labels };
}

function annotationMarkup(input: StrategyInput, boxes: Map<string, Box>) {
  let markup = '<defs><marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10" fill="none" stroke="#ff7066" stroke-width="2"/></marker></defs>';
  for (const item of input.annotations) {
    const from = boxes.get(item.from);
    if (!from) continue;
    const x = from.x + from.width / 2, y = from.y + (from.height - 108) / 2;
    const to = item.to ? boxes.get(item.to) : undefined;
    if (to && ['arrow', 'double-arrow'].includes(item.type)) {
      const tx = to.x + to.width / 2, ty = to.y + (to.height - 108) / 2;
      const distance = Math.hypot(tx - x, ty - y), trim = Math.min(from.width * 0.45, distance * 0.3);
      const dx = (tx - x) / distance, dy = (ty - y) / distance;
      markup += `<path d="M${x + dx * trim} ${y + dy * trim} L${tx - dx * trim} ${ty - dy * trim}" stroke="#ff7066" stroke-width="6" fill="none" marker-end="url(#arrow)" ${item.type === 'double-arrow' ? 'marker-start="url(#arrow)"' : ''}/>`;
    } else if (to && ['plus', 'equals'].includes(item.type)) {
      markup += text(item.type === 'plus' ? '+' : '=', (x + to.x + to.width / 2) / 2 - 15, (y + to.y + (to.height - 108) / 2) / 2, 90, 48, ACCENT, 1);
    } else if (item.type === 'strike') {
      markup += `<path d="M${from.x} ${from.y} L${from.x + from.width} ${from.y + from.height - 108}" stroke="#ff7066" stroke-width="7"/>`;
    } else if (item.type === 'question') markup += text('?', x - 14, from.y + 46, 60, 46, ACCENT, 1);
    else if (item.type === 'label') markup += text(item.text || '', from.x, from.y + from.height - 5, from.width, 18, ACCENT, 1);
  }
  return markup;
}

async function budget<T>(action: (fetcher: typeof fetch) => Promise<T>, fetcher: typeof fetch) {
  if (activeRenders >= 2) throw new SourceError('BUILDER_BUSY_RETRY');
  activeRenders++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const bounded: typeof fetch = (url, init) => fetcher(url, { ...init,
    signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal });
  try { return await action(bounded); }
  catch (error) { if (controller.signal.aborted) throw new SourceError('BUILDER_TIMEOUT_RETRY'); throw error; }
  finally { clearTimeout(timer); controller.abort(); activeRenders--; }
}

async function finish(title: string, height: number, tiles: Tile[], decoration: string, annotations: string, config: Config, fetcher: typeof fetch): Promise<BuilderImage> {
  if (WIDTH * height > 16_000_000) throw new SourceError('BUILDER_CANVAS_TOO_LARGE_USE_MORE_COLUMNS');
  const cards = await resolveBuilderCards(tiles, config, fetcher);
  const { layers, labels } = await tileLayers(tiles, cards);
  const buffer = await sharp(svg(background(title, height) + decoration, height), { limitInputPixels: 16_000_000 })
    .composite([...layers, { input: svg(labels + annotations, height), top: 0, left: 0 }]).png().toBuffer();
  if (buffer.length > 8 * 1024 * 1024) throw new SourceError('BUILDER_IMAGE_TOO_LARGE');
  return { buffer, mimeType: 'image/png', width: WIDTH, height, cardCount: tiles.length, sourceUrls: [...cards.values()].map(card => card.sourceUrl) };
}

export function renderStrategy(input: StrategyInput, config: Config, fetcher: typeof fetch = fetch) {
  return budget(async bounded => {
    const rows = input.rows ?? Math.max(...input.cards.map(card => card.row));
    const cellWidth = 300, cellHeight = 510, height = TOP + rows * cellHeight + 60;
    const tiles: Tile[] = input.cards.map(card => ({ ...card, box: { x: 68 + (card.column - 1) * cellWidth, y: TOP + (card.row - 1) * cellHeight + 16, width: 260, height: 478 } }));
    let decoration = `<rect x="48" y="${TOP}" width="1500" height="${rows * cellHeight}" fill="${PANEL}"/>`;
    if (input.showGrid) {
      for (let column = 1; column < 5; column++) decoration += `<path d="M${48 + column * cellWidth} ${TOP} v${rows * cellHeight}" stroke="#9a7745"/>`;
      for (let row = 1; row < rows; row++) decoration += `<path d="M48 ${TOP + row * cellHeight} h1500" stroke="#9a7745"/>`;
    }
    return finish(input.title, height, tiles, decoration, annotationMarkup(input, new Map(tiles.map(tile => [tile.key, tile.box]))), config, bounded);
  }, fetcher);
}

export function renderTierList(input: TierListInput, config: Config, fetcher: typeof fetch = fetch) {
  return budget(async bounded => {
    const cellWidth = Math.floor((1380 - GAP * (input.columns - 1)) / input.columns);
    const cardWidth = Math.min(240, cellWidth), cellHeight = 478;
    const tiles: Tile[] = [];
    let y = TOP, decoration = '';
    for (const tier of input.tiers) {
      const count = Math.max(1, Math.ceil(tier.cards.length / input.columns));
      const rowHeight = tier.cards.length ? count * cellHeight + 24 : 156;
      decoration += `<rect x="36" y="${y}" width="1528" height="${rowHeight}" rx="6" fill="${PANEL}" stroke="#b89a69"/><rect x="48" y="${y + 12}" width="96" height="${rowHeight - 24}" rx="4" fill="${ACCENT}"/>`;
      decoration += text(tier.tier, 76, y + 66, 65, 44, PAPER, 1);
      if (tier.label) decoration += text(tier.label, 55, y + 94, 80, 14, PAPER, 3);
      tier.cards.forEach((card, index) => tiles.push({ ...card, key: `${tier.tier}:${index}`, box: {
        x: 164 + index % input.columns * (cellWidth + GAP), y: y + 12 + Math.floor(index / input.columns) * cellHeight, width: cardWidth, height: 454 } }));
      y += rowHeight + 16;
    }
    return finish(input.title, y + 44, tiles, decoration, '', config, bounded);
  }, fetcher);
}
