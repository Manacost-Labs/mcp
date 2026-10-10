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

export type ArticleImage = { index: number; url: string; alt: string; caption: string; originalUrl?: string;
  width?: number; height?: number; srcset: { url: string; descriptor: string }[] };

export function extractArticleImages(html: string, articleUrl: string): ArticleImage[] {
  const $ = load(html);
  $('script,style,noscript,iframe,form').remove();
  const resolve = (raw: string | undefined) => {
    if (!raw) return undefined;
    try {
      const url = new URL(raw, articleUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) return undefined;
      url.hash = ''; return url.href;
    } catch { return undefined; }
  };
  const dimension = (raw: string | undefined) => raw && /^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) <= 100000 ? Number(raw) : undefined;
  const images: ArticleImage[] = [];
  $('img').each((_i, element) => {
    const image = $(element);
    const srcset = (image.attr('data-srcset') ?? image.attr('srcset') ?? '').split(',').flatMap(entry => {
      const match = entry.trim().match(/^(\S+)(?:\s+(\d+w|\d+(?:\.\d+)?x))?$/);
      const url = match && resolve(match[1]);
      return url ? [{ url, descriptor: match?.[2] ?? '' }] : [];
    }).slice(0, 20);
    const url = resolve(image.attr('data-src')) ?? resolve(image.attr('data-lazy-src')) ??
      resolve(image.attr('data-original')) ?? resolve(image.attr('src')) ?? srcset[0]?.url;
    if (!url) return;
    const linked = resolve(image.closest('a[href]').attr('href'));
    const largest = [...srcset].sort((a, b) => parseFloat(b.descriptor || '0') - parseFloat(a.descriptor || '0'))[0]?.url;
    const originalUrl = linked && /\.(?:avif|gif|jpe?g|png|webp)$/i.test(new URL(linked).pathname) ? linked : largest;
    const caption = image.closest('figure').find('figcaption').first();
    const legacyCaption = image.closest('.wp-caption').find('.wp-caption-text').first();
    images.push({ index: images.length, url, originalUrl, alt: (image.attr('alt') ?? '').slice(0, 1024),
      caption: htmlText((caption.length ? caption : legacyCaption).html() ?? '').slice(0, 2048),
      width: dimension(image.attr('width')), height: dimension(image.attr('height')), srcset });
  });
  return images;
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
  const structuredData: unknown[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try { if (structuredData.length < 20) structuredData.push(JSON.parse($(el).text())); } catch { /* Invalid public markup is omitted. */ }
  });
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || url;
  const canonical = resolve($('link[rel="canonical"]').attr('href'));
  const body = $('article .entry-content,.entry-content,article,main').first();
  const bodyHtml = body.length ? body.html() ?? '' : $('body').html() ?? '';
  const text = htmlText(bodyHtml), images = extractArticleImages(bodyHtml, url);
  return { title, text, metadata: { kind: 'page', access: 'public', canonical, description: meta('description'),
    robots: meta('robots'), openGraph: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image'), type: meta('og:type') },
    headings, navigation, links, images, structuredData } };
}
