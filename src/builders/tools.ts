import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Config } from '../config.js';
import { SourceError } from '../http.js';
import { strategySchema, tierListSchema } from './contracts.js';
import { renderStrategy, renderTierList, type BuilderImage } from './render.js';

/** Native image content lets compatible MCP clients display the generated board inline. */
export function registerBuilderTools(server: McpServer, config: Config, fetcher: typeof fetch) {
  const register = <T extends z.ZodObject>(name: string, description: string, schema: T,
    render: (input: z.output<T>) => Promise<BuilderImage>) => {
    const inputSchema: StandardSchemaWithJSON = schema;
    server.registerTool(name, { description, inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, async input => {
      try {
        const result = await render(input as z.output<T>);
        return { content: [
          { type: 'text' as const, text: JSON.stringify({ width: result.width, height: result.height,
            cardCount: result.cardCount, sourceUrls: result.sourceUrls, retrievedAt: new Date().toISOString() }) },
          { type: 'image' as const, mimeType: result.mimeType, data: result.buffer.toString('base64') },
        ] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const,
          text: JSON.stringify({ error: error instanceof SourceError ? error.code : 'BUILDER_RENDER_FAILED' }) }] };
      }
    });
  };
  register('render_battlegrounds_strategy',
    'Render a HearthPulse Battlegrounds strategy as an inline PNG with original catalog artwork. Discover cardIds with search_cards(mode=battlegrounds). source is card, hero or trinket. Place cards in 1-based rows (1–10) and columns (1–5), with unique keys for annotation links. rows defaults to the last occupied row. Never invent cardIds; missing artwork produces an error instead of a partial image.',
    strategySchema, input => renderStrategy(input, config, fetcher));
  register('render_battlegrounds_tier_list',
    'Render a HearthPulse Battlegrounds S/A/B/C/D tier list as an inline PNG with original catalog artwork. Discover cardIds with search_cards(mode=battlegrounds). source is card, hero or trinket. Supply tiers in desired order and optional labels, notes and highlights; columns controls wrapping (1–10). Missing artwork produces an error instead of a partial image.',
    tierListSchema, input => renderTierList(input, config, fetcher));
}
