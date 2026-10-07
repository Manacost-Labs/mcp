import { load } from 'cheerio';

/** VIP Gutenberg blocks keep the paid body in comment JSON, not in rendered HTML. */
export function wordPressBody(raw: string) {
  const lockerBlocks = new RegExp('<!--\\s*wp:svl/locker\\s+(\\{[\\s\\S]*?\\})\\s*/?-->', 'g');
  const expanded = raw.replace(lockerBlocks, (_match, json: string) => {
    try { const attrs = JSON.parse(json) as { content?: unknown }; return typeof attrs.content === 'string' ? attrs.content : ''; }
    catch { throw new Error('Invalid VIP block payload'); }
  });
  // Remove shortcode attributes, including VIP unlock codes; retain the body.
  return expanded.replace(/\[\/?[A-Za-z_][\w-]*(?:\s[^\]]*)?\]/g, '');
}

export function htmlText(html: string) {
  const $ = load(html);
  $('script,style,noscript,iframe,form').remove();
  $('br').replaceWith('\n');
  $('p,li,h1,h2,h3,h4,div,section,table,tr').append('\n');
  return $.root().text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
}

export function extractPage(html: string, url: string) {
  const $ = load(html);
  const resolve = (value: string | undefined) => {
    if (!value) return null;
    try { const resolved = new URL(value, url); return ['https:', 'http:'].includes(resolved.protocol) ? resolved.href : null; }
    catch { return null; }
  };
  const meta = (name: string) => $(`meta[name="${name}"],meta[property="${name}"]`).first().attr('content') ?? null;
  const headings = $('h1,h2,h3').toArray().map(el => ({ level: el.tagName, text: $(el).text().trim() })).filter(h => h.text).slice(0, 100);
  const links = $('a[href]').toArray().map(el => ({ text: $(el).text().trim().slice(0, 200), url: resolve($(el).attr('href')) }))
    .filter(l => l.url).slice(0, 500);
  const navigation = $('nav a[href],header a[href],footer a[href]').toArray().map(el => ({ text: $(el).text().trim().slice(0, 200), url: resolve($(el).attr('href')) }))
    .filter(l => l.url).slice(0, 200);
  const images = $('img[src]').toArray().map(el => ({ url: resolve($(el).attr('src')), alt: $(el).attr('alt') ?? '' })).filter(i => i.url).slice(0, 100);
  const structuredData: unknown[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try { if (structuredData.length < 20) structuredData.push(JSON.parse($(el).text())); } catch { /* Invalid public markup is omitted. */ }
  });
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || url;
  const canonical = resolve($('link[rel="canonical"]').attr('href'));
  const body = $('article .entry-content,.entry-content,article,main').first();
  const text = htmlText(body.length ? body.html() ?? '' : $('body').html() ?? '');
  return { title, text, metadata: { kind: 'page', access: 'public', canonical, description: meta('description'),
    robots: meta('robots'), openGraph: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image'), type: meta('og:type') },
    headings, navigation, links, images, structuredData } };
}
