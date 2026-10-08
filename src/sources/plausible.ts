import { z } from 'zod';
import type { Config } from '../config.js';
import { fetchJson, SourceError } from '../http.js';

const metric = z.enum(['visitors', 'visits', 'pageviews', 'views_per_visit', 'bounce_rate', 'visit_duration',
  'events', 'percentage', 'conversion_rate', 'group_conversion_rate']);
const dimension = z.enum(['event:page', 'event:hostname', 'event:goal', 'visit:source', 'visit:referrer',
  'visit:utm_source', 'visit:utm_medium', 'visit:utm_campaign', 'visit:utm_content', 'visit:utm_term',
  'visit:entry_page', 'visit:exit_page', 'visit:device', 'visit:browser', 'visit:os', 'visit:country',
  'visit:region', 'visit:city', 'time', 'time:hour', 'time:day', 'time:week', 'time:month']);
const filterDimension = dimension.exclude(['time', 'time:hour', 'time:day', 'time:week', 'time:month']);
const customDates = z.tuple([z.iso.date(), z.iso.date()]).refine(([from, to]) => {
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  return days >= 0 && days <= 366;
}, 'Custom ranges must be ordered and span at most 366 days');

/** A bounded subset of the read-only Stats API, never an Events or Sites write API. */
export const plausibleQuerySchema = z.object({
  siteId: z.string().min(1).max(253),
  dateRange: z.union([z.enum(['day', '24h', '7d', '28d', '30d', '91d', 'month', '6mo', '12mo', 'year', 'all']), customDates]).default('7d'),
  metrics: z.array(metric).min(1).max(10).default(['visitors', 'pageviews']),
  dimensions: z.array(dimension).max(3).default([]),
  filters: z.array(z.tuple([z.enum(['is', 'is_not', 'contains', 'contains_not', 'matches', 'matches_not']),
    filterDimension, z.array(z.string().max(500)).min(1).max(20)])).max(10).default([]),
  orderBy: z.array(z.tuple([z.union([metric, dimension]), z.enum(['asc', 'desc'])])).max(3).optional(),
  includeImports: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(100000).default(0),
}).strict().superRefine((q, ctx) => {
  if (new Set(q.metrics).size !== q.metrics.length || new Set(q.dimensions).size !== q.dimensions.length) {
    ctx.addIssue({ code: 'custom', message: 'Metrics and dimensions must be unique' });
  }
  if (q.orderBy?.some(([field]) => !q.metrics.includes(field as z.infer<typeof metric>) && !q.dimensions.includes(field as z.infer<typeof dimension>))) {
    ctx.addIssue({ code: 'custom', message: 'Order fields must be selected metrics or dimensions' });
  }
});

const responseSchema = z.object({
  results: z.array(z.object({ metrics: z.array(z.number().finite().nullable()), dimensions: z.array(z.union([z.string(), z.number(), z.null()])) })),
  meta: z.object({ total_rows: z.number().int().nonnegative().optional() }).passthrough(),
  query: z.record(z.string(), z.unknown()),
});

export class PlausibleApi {
  constructor(private config: Config, private fetcher: typeof fetch = fetch) {}

  sites() {
    return { configured: Boolean(this.config.plausibleApiKey && this.config.plausibleSiteIds.length),
      sites: this.config.plausibleSiteIds.map(siteId => ({ siteId, dashboardUrl: `${this.config.plausibleDashboardUrl}/${encodeURIComponent(siteId)}` })) };
  }

  async query(input: z.input<typeof plausibleQuerySchema>) {
    const q = plausibleQuerySchema.parse(input);
    if (!this.config.plausibleApiKey || !this.config.plausibleSiteIds.length) throw new SourceError('PLAUSIBLE_NOT_CONFIGURED');
    if (!this.config.plausibleSiteIds.includes(q.siteId)) throw new SourceError('PLAUSIBLE_SITE_NOT_ALLOWED');
    let data: unknown;
    try {
      ({ data } = await fetchJson(`${this.config.plausibleUrl}/api/v2/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.plausibleApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: q.siteId, date_range: q.dateRange, metrics: q.metrics, dimensions: q.dimensions,
          filters: q.filters, ...(q.orderBy ? { order_by: q.orderBy } : {}),
          pagination: { limit: q.limit, offset: q.offset }, include: { total_rows: true, imports: q.includeImports } }),
      }, this.fetcher));
    } catch (error) {
      if (error instanceof SourceError && error.code === 'UPSTREAM_HTTP_400') throw new SourceError('PLAUSIBLE_QUERY_REJECTED');
      throw error;
    }
    const parsed = responseSchema.safeParse(data);
    if (!parsed.success || parsed.data.results.length > q.limit || parsed.data.results.some(row => row.metrics.length !== q.metrics.length || row.dimensions.length !== q.dimensions.length)) {
      throw new SourceError('PLAUSIBLE_INVALID_RESPONSE');
    }
    const result = parsed.data;
    const end = q.offset + result.results.length;
    return { siteId: q.siteId, sourceUrl: `${this.config.plausibleDashboardUrl}/${encodeURIComponent(q.siteId)}`,
      metrics: q.metrics, dimensions: q.dimensions, ...result,
      nextOffset: result.results.length && (result.meta.total_rows === undefined ? result.results.length === q.limit : end < result.meta.total_rows) ? end : null };
  }
}
