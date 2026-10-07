import { z } from 'zod';
import { fetchJson, SourceError } from '../http.js';

export const pageSchema = z.object({ limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(100000).default(0), after: z.string().max(4096).optional() })
  .refine(v => !v.after || v.offset === 0, 'Do not combine a cursor with a nonzero offset');
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const pageFields = 'pageInfo { total hasNextPage nextCursor }';

/** Encode GraphQL input literals, never operation text supplied by a client. */
export function graphValue(value: unknown, depth = 0): string {
  if (depth > 8) throw new Error('Filter is too deeply nested');
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    if (value.length > 200) throw new Error('Too many filter values');
    return `[${value.map(v => graphValue(v, depth + 1)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, v]) => {
      if (!identifier.test(key)) throw new Error('Invalid filter field');
      return `${key}:${graphValue(v, depth + 1)}`;
    }).join(',')}}`;
  }
  throw new Error('Invalid GraphQL input');
}
const args = (values: Record<string, unknown>) => Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}:${graphValue(v)}`).join(',');

export class KolodaApi {
  constructor(private baseUrl: string, private token?: string, private fetcher: typeof fetch = fetch) {}

  private async query(field: string, input: Record<string, unknown>, selection: string, needsDatabase = false) {
    if (needsDatabase && !this.token) throw new SourceError('KOLODA_DATABASE_TOKEN_NOT_CONFIGURED');
    const { data } = await fetchJson(`${this.baseUrl}/v1/graphql`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ query: `query { ${field}(${args(input)}) { ${selection} } }` }),
    }, this.fetcher);
    const envelope = z.object({ data: z.record(z.string(), z.unknown()).nullish(), errors: z.array(z.unknown()).optional() }).safeParse(data);
    if (!envelope.success || envelope.data.errors?.length || !envelope.data.data || !(field in envelope.data.data)) throw new SourceError('KOLODA_GRAPHQL_ERROR');
    return envelope.data.data[field];
  }

  collections(input: { schemaName?: string; limit: number; offset: number; after?: string }) {
    return this.query('collections', input, `items { collection primaryKey estimatedRowCount columns { name dataType nullable } } ${pageFields}`, true);
  }
  records(input: { collection: string; fields?: string[]; filters?: Record<string, unknown>; orderBy?: string; limit: number; offset: number; after?: string }) {
    return this.query('records', input, `items ${pageFields}`, true);
  }
  search(input: { query: string; limit: number; offset: number; after?: string }) {
    return this.query('search', input, `items { kind entityId name nameRu subtitle imageUrl sourceId metadata } ${pageFields}`);
  }
  async get(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    return (await fetchJson(url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} }, this.fetcher)).data;
  }
}
