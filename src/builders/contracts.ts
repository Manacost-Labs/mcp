import { z } from 'zod';

const cardId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const reference = {
  cardId,
  source: z.enum(['card', 'hero', 'trinket']).default('card'),
  note: z.string().max(80).optional(),
  highlighted: z.boolean().default(false),
};
const placement = z.strictObject({ ...reference, key: cardId,
  row: z.number().int().min(1).max(10), column: z.number().int().min(1).max(5) });
const annotation = z.strictObject({ type: z.enum(['arrow', 'double-arrow', 'plus', 'equals', 'question', 'strike', 'label']),
  from: cardId, to: cardId.optional(), text: z.string().max(80).optional() });

export const strategySchema = z.object({ title: z.string().max(100).default('Стратегия БГ'),
  rows: z.number().int().min(1).max(10).optional(), showGrid: z.boolean().default(true),
  cards: z.array(placement).min(1).max(50), annotations: z.array(annotation).max(100).default([]),
}).superRefine((input, ctx) => {
  const keys = new Set<string>(), slots = new Set<string>();
  input.cards.forEach((card, index) => {
    const slot = `${card.row}:${card.column}`;
    if (keys.has(card.key) || slots.has(slot) || card.row > (input.rows ?? 10))
      ctx.addIssue({ code: 'custom', path: ['cards', index], message: 'Unique keys and unoccupied cells inside the selected rows are required' });
    keys.add(card.key); slots.add(slot);
  });
  input.annotations.forEach((item, index) => {
    const pair = ['arrow', 'double-arrow', 'plus', 'equals'].includes(item.type);
    if (!keys.has(item.from) || (pair && (!item.to || !keys.has(item.to) || item.to === item.from)) ||
      (item.type === 'label' && !item.text?.trim()))
      ctx.addIssue({ code: 'custom', path: ['annotations', index], message: 'Annotation must reference existing distinct card keys; labels require text' });
  });
});

export const tierListSchema = z.object({ title: z.string().max(100).default('Тир-лист БГ'),
  columns: z.number().int().min(1).max(10).default(5),
  tiers: z.array(z.strictObject({ tier: z.enum(['S', 'A', 'B', 'C', 'D']),
    label: z.string().max(40).optional(), cards: z.array(z.strictObject(reference)).max(50) })).min(1).max(5),
}).superRefine((input, ctx) => {
  if (new Set(input.tiers.map(tier => tier.tier)).size !== input.tiers.length)
    ctx.addIssue({ code: 'custom', message: 'Each tier may appear only once' });
  const count = input.tiers.reduce((sum, tier) => sum + tier.cards.length, 0);
  if (count === 0 || count > 100) ctx.addIssue({ code: 'custom', message: 'Use between 1 and 100 cards' });
  const identities = input.tiers.flatMap(tier => tier.cards.map(card => `${card.source}:${card.cardId}`));
  if (new Set(identities).size !== identities.length)
    ctx.addIssue({ code: 'custom', message: 'Place each catalog card in only one tier' });
});

export type BuilderCard = z.output<typeof placement>;
export type StrategyInput = z.output<typeof strategySchema>;
export type TierListInput = z.output<typeof tierListSchema>;
